/**
 * Claudian - Slash command settings
 *
 * Settings UI for managing slash commands with create/edit/delete/import/export.
 */

import type { App} from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { SlashCommand } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { parseSlashCommandContent } from '../../../utils/slashCommand';

/** Check if a command is a user-defined command (not from a plugin). */
function isUserCommand(cmd: SlashCommand): boolean {
  return !cmd.id.startsWith('plugin-');
}

/** Modal for creating/editing slash commands. */
export class SlashCommandModal extends Modal {
  private plugin: ClaudianPlugin;
  private existingCmd: SlashCommand | null;
  private onSave: (cmd: SlashCommand) => void;

  constructor(
    app: App,
    plugin: ClaudianPlugin,
    existingCmd: SlashCommand | null,
    onSave: (cmd: SlashCommand) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.existingCmd = existingCmd;
    this.onSave = onSave;
  }

  onOpen() {
    this.setTitle(this.existingCmd ? 'Edit Slash Command' : 'Add Slash Command');
    this.modalEl.addClass('claudian-slash-modal');

    const { contentEl } = this;

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let hintInput: HTMLInputElement;
    let modelInput: HTMLInputElement;
    let toolsInput: HTMLInputElement;

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

    new Setting(contentEl)
      .setName('Argument hint')
      .setDesc('Placeholder text for arguments (e.g., "[file] [focus]")')
      .addText(text => {
        hintInput = text.inputEl;
        text.setValue(this.existingCmd?.argumentHint || '');
      });

    new Setting(contentEl)
      .setName('Model override')
      .setDesc('Optional model to use for this command')
      .addText(text => {
        modelInput = text.inputEl;
        text.setValue(this.existingCmd?.model || '')
          .setPlaceholder('claude-sonnet-4-5');
      });

    new Setting(contentEl)
      .setName('Allowed tools')
      .setDesc('Comma-separated list of tools to allow (empty = all)')
      .addText(text => {
        toolsInput = text.inputEl;
        text.setValue(this.existingCmd?.allowedTools?.join(', ') || '');
      });

    new Setting(contentEl)
      .setName('Prompt template')
      .setDesc('Use $ARGUMENTS, $1, $2, @file, !`bash`');

    const contentArea = contentEl.createEl('textarea', {
      cls: 'claudian-slash-content-area',
      attr: {
        rows: '10',
        placeholder: 'Review this code for:\n$ARGUMENTS\n\n@$1',
      },
    });
    const initialContent = this.existingCmd
      ? parseSlashCommandContent(this.existingCmd.content).promptContent
      : '';
    contentArea.value = initialContent;

    // Button container
    const buttonContainer = contentEl.createDiv({ cls: 'claudian-slash-modal-buttons' });

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
      if (!name) {
        new Notice('Command name is required');
        return;
      }

      const content = contentArea.value;
      if (!content.trim()) {
        new Notice('Prompt template is required');
        return;
      }

      // Validate name (alphanumeric, hyphens, underscores, slashes only - colons reserved for plugins)
      if (!/^[a-zA-Z0-9_/-]+$/.test(name)) {
        new Notice('Command name can only contain letters, numbers, hyphens, underscores, and slashes');
        return;
      }

      // Check for duplicate names in current in-memory commands (excluding current command if editing)
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

      const cmd: SlashCommand = {
        id: this.existingCmd?.id || `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        name,
        description: descInput.value.trim() || parsed.description || undefined,
        argumentHint: hintInput.value.trim() || parsed.argumentHint || undefined,
        model: modelInput.value.trim() || parsed.model || undefined,
        allowedTools: toolsInput.value.trim()
          ? toolsInput.value.split(',').map(s => s.trim()).filter(Boolean)
          : parsed.allowedTools && parsed.allowedTools.length > 0
            ? parsed.allowedTools
            : undefined,
        content: promptContent,
      };

      this.onSave(cmd);
      this.close();
    });

    // Keyboard shortcuts
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

/** Component for managing slash commands in settings. */
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

    // Header with add button
    const headerEl = this.containerEl.createDiv({ cls: 'claudian-slash-header' });
    headerEl.createSpan({ text: 'Slash Commands', cls: 'claudian-slash-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-slash-header-actions' });

    const importBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Import' },
    });
    setIcon(importBtn, 'download');
    importBtn.addEventListener('click', () => this.importCommands());

    const exportBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Export' },
    });
    setIcon(exportBtn, 'upload');
    exportBtn.addEventListener('click', () => this.exportCommands());

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openCommandModal(null));

    // Filter out plugin commands (they're managed in the plugins section)
    const commands = this.plugin.settings.slashCommands.filter(isUserCommand);

    if (commands.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-slash-empty-state' });
      emptyEl.setText('No slash commands configured. Click "Add" to create one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-slash-list' });

    for (const cmd of commands) {
      this.renderCommandItem(listEl, cmd);
    }
  }

  private renderCommandItem(listEl: HTMLElement, cmd: SlashCommand): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-slash-item-settings' });

    const infoEl = itemEl.createDiv({ cls: 'claudian-slash-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-slash-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'claudian-slash-item-name' });
    nameEl.setText(`/${cmd.name}`);

    if (cmd.argumentHint) {
      const hintEl = headerRow.createSpan({ cls: 'claudian-slash-item-hint' });
      hintEl.setText(cmd.argumentHint);
    }

    if (cmd.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-slash-item-desc' });
      descEl.setText(cmd.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-slash-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openCommandModal(cmd));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      try {
        await this.deleteCommand(cmd);
      } catch {
        new Notice('Failed to delete slash command');
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

  private async saveCommand(cmd: SlashCommand, existing: SlashCommand | null): Promise<void> {
    // Save new file first (safer: if this fails, old file still exists)
    await this.plugin.storage.commands.save(cmd);

    // Delete old file only after successful save (if name changed)
    if (existing && existing.name !== cmd.name) {
      await this.plugin.storage.commands.delete(existing.id);
    }

    // Reload commands from storage
    await this.reloadCommands();

    this.render();
    new Notice(`Slash command "/${cmd.name}" ${existing ? 'updated' : 'created'}`);
  }

  private async deleteCommand(cmd: SlashCommand): Promise<void> {
    // Delete from file storage
    await this.plugin.storage.commands.delete(cmd.id);

    // Reload commands from storage
    await this.reloadCommands();

    this.render();
    new Notice(`Slash command "/${cmd.name}" deleted`);
  }

  /** Reload commands from storage and update in-memory settings. */
  private async reloadCommands(): Promise<void> {
    const commands = await this.plugin.storage.commands.loadAll();
    this.plugin.settings.slashCommands = commands;
  }

  private exportCommands(): void {
    // Filter out plugin commands (they're managed separately)
    const commands = this.plugin.settings.slashCommands.filter(isUserCommand);
    if (commands.length === 0) {
      new Notice('No slash commands to export');
      return;
    }

    const json = JSON.stringify(commands, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claudian-slash-commands.json';
    a.click();
    URL.revokeObjectURL(url);
    new Notice(`Exported ${commands.length} slash command(s)`);
  }

  private importCommands(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const commands = JSON.parse(text) as SlashCommand[];

        if (!Array.isArray(commands)) {
          throw new Error('Invalid format: expected an array');
        }

        // Reload current commands to check for duplicates
        const existingCommands = await this.plugin.storage.commands.loadAll();
        const existingNames = new Set(existingCommands.map(c => c.name.toLowerCase()));

        let imported = 0;
        for (const cmd of commands) {
          // Validate required fields
          if (!cmd.name || !cmd.content) {
            continue;
          }

          if (typeof cmd.name !== 'string' || typeof cmd.content !== 'string') {
            continue;
          }

          // Validate name (alphanumeric, hyphens, underscores, slashes, colons)
          if (!/^[a-zA-Z0-9_/:-]+$/.test(cmd.name)) {
            continue;
          }

          // Assign new ID to avoid conflicts
          cmd.id = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

          // Normalize optional fields
          if (cmd.allowedTools && !Array.isArray(cmd.allowedTools)) {
            cmd.allowedTools = undefined;
          }

          if (Array.isArray(cmd.allowedTools)) {
            cmd.allowedTools = cmd.allowedTools.filter((t) => typeof t === 'string' && t.trim().length > 0);
            if (cmd.allowedTools.length === 0) {
              cmd.allowedTools = undefined;
            }
          }

          if (cmd.description && typeof cmd.description !== 'string') {
            cmd.description = undefined;
          }
          if (cmd.argumentHint && typeof cmd.argumentHint !== 'string') {
            cmd.argumentHint = undefined;
          }
          if (cmd.model && typeof cmd.model !== 'string') {
            cmd.model = undefined;
          }

          // Fill missing fields from frontmatter
          const parsed = parseSlashCommandContent(cmd.content);
          cmd.description = cmd.description || parsed.description;
          cmd.argumentHint = cmd.argumentHint || parsed.argumentHint;
          cmd.model = cmd.model || parsed.model;
          cmd.allowedTools = cmd.allowedTools || parsed.allowedTools;
          cmd.content = parsed.promptContent;

          // Check for duplicate names
          if (existingNames.has(cmd.name.toLowerCase())) {
            // Skip duplicates
            continue;
          }

          // Save to file storage
          await this.plugin.storage.commands.save(cmd);
          existingNames.add(cmd.name.toLowerCase());
          imported++;
        }

        // Reload commands from storage
        await this.reloadCommands();

        this.render();
        new Notice(`Imported ${imported} slash command(s)`);
      } catch {
        new Notice('Failed to import slash commands. Check file format.');
      }
    });
    input.click();
  }

  public refresh(): void {
    this.render();
  }
}
