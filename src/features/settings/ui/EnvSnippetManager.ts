/**
 * Claudian - Environment snippet manager
 *
 * Manages saving and restoring environment variable configurations.
 */

import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { EnvSnippet } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { formatContextLimit, parseContextLimit, parseEnvironmentVariables } from '../../../utils/env';
import type { ClaudianView } from '../../chat/ClaudianView';

/** Modal for creating/editing environment variable snippets. */
export class EnvSnippetModal extends Modal {
  plugin: ClaudianPlugin;
  snippet: EnvSnippet | null;
  onSave: (snippet: EnvSnippet) => void;

  constructor(app: App, plugin: ClaudianPlugin, snippet: EnvSnippet | null, onSave: (snippet: EnvSnippet) => void) {
    super(app);
    this.plugin = plugin;
    this.snippet = snippet;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.snippet ? 'Edit snippet' : 'Save snippet');

    // Make modal more compact
    this.modalEl.addClass('claudian-env-snippet-modal');

    let nameEl: HTMLInputElement;
    let descEl: HTMLInputElement;
    let envVarsEl: HTMLTextAreaElement;
    const contextLimitInputs: Map<string, HTMLInputElement> = new Map();
    let contextLimitsContainer: HTMLElement | null = null;

    // Add keyboard shortcuts for name/description fields
    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        saveSnippet();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        this.close();
      }
    };

    const saveSnippet = () => {
      const name = nameEl.value.trim();
      if (!name) {
        new Notice('Please enter a name for the snippet');
        return;
      }

      // Collect context limits from inputs
      const contextLimits: Record<string, number> = {};
      for (const [modelId, input] of contextLimitInputs) {
        const value = input.value.trim();
        if (value) {
          const parsed = parseContextLimit(value);
          if (parsed !== null) {
            contextLimits[modelId] = parsed;
          }
        }
      }

      const snippet: EnvSnippet = {
        id: this.snippet?.id || `snippet-${Date.now()}`,
        name,
        description: descEl.value.trim(),
        envVars: envVarsEl.value,
        contextLimits: Object.keys(contextLimits).length > 0 ? contextLimits : undefined,
      };

      this.onSave(snippet);
      this.close();
    };

    // Function to render context limit fields based on env vars
    const renderContextLimitFields = () => {
      if (!contextLimitsContainer) return;
      contextLimitsContainer.empty();
      contextLimitInputs.clear();

      // Parse env vars to detect custom models
      const envVars = parseEnvironmentVariables(envVarsEl.value);
      const customModelEnvKeys = [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ];

      // Collect unique model IDs
      const uniqueModelIds = new Set<string>();
      for (const envKey of customModelEnvKeys) {
        const modelId = envVars[envKey];
        if (modelId) {
          uniqueModelIds.add(modelId);
        }
      }

      if (uniqueModelIds.size === 0) {
        contextLimitsContainer.style.display = 'none';
        return;
      }

      contextLimitsContainer.style.display = 'block';

      // Get existing context limits (from snippet or current settings)
      const existingLimits = this.snippet?.contextLimits ?? this.plugin.settings.customContextLimits ?? {};

      contextLimitsContainer.createEl('div', {
        text: 'Context limits',
        cls: 'setting-item-name',
      });
      const desc = contextLimitsContainer.createEl('div', {
        text: 'Set context window size for each model (e.g., 256k, 1m)',
        cls: 'setting-item-description',
      });
      desc.style.marginBottom = '0.5em';

      for (const modelId of uniqueModelIds) {
        const row = contextLimitsContainer.createDiv({ cls: 'claudian-snippet-limit-row' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '0.5em';
        row.style.marginBottom = '0.25em';

        row.createSpan({ text: modelId, cls: 'claudian-snippet-limit-model' });
        row.createSpan().style.flex = '1';

        const input = row.createEl('input', {
          type: 'text',
          placeholder: '200k',
          cls: 'claudian-snippet-limit-input',
        });
        input.style.width = '80px';
        input.value = existingLimits[modelId] ? formatContextLimit(existingLimits[modelId]) : '';
        contextLimitInputs.set(modelId, input);
      }
    };

    new Setting(contentEl)
      .setName('Name')
      .setDesc('A descriptive name for this environment configuration')
      .addText((text) => {
        nameEl = text.inputEl;
        text.setValue(this.snippet?.name || '');
                text.inputEl.addEventListener('keydown', handleKeyDown);
      });

    new Setting(contentEl)
      .setName('Description')
      .setDesc('Optional description')
      .addText((text) => {
        descEl = text.inputEl;
        text.setValue(this.snippet?.description || '');
                text.inputEl.addEventListener('keydown', handleKeyDown);
      });

    // Editable environment variables - full width layout
    const envVarsSetting = new Setting(contentEl)
      .setName('Environment variables')
      .setDesc('KEY=VALUE format, one per line')
      .addTextArea((text) => {
        envVarsEl = text.inputEl;
        const envVarsToShow = this.snippet?.envVars ?? this.plugin.settings.environmentVariables;
        text.setValue(envVarsToShow);
        text.inputEl.rows = 8;
        // Refresh context limit fields when env vars change
        text.inputEl.addEventListener('blur', () => renderContextLimitFields());
      });
    // Make textarea full width under the label
    envVarsSetting.settingEl.addClass('claudian-env-snippet-setting');
    envVarsSetting.controlEl.addClass('claudian-env-snippet-control');

    // Editable context limits section
    contextLimitsContainer = contentEl.createDiv({ cls: 'claudian-snippet-context-limits' });
    contextLimitsContainer.style.marginTop = '1em';
    renderContextLimitFields();

    // Compact button container
    const buttonContainer = contentEl.createDiv({ cls: 'claudian-snippet-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn'
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: this.snippet ? 'Update' : 'Save',
      cls: 'claudian-save-btn'
    });
    saveBtn.addEventListener('click', () => saveSnippet());

    // Focus name input after modal is rendered (timeout for Windows compatibility)
    setTimeout(() => nameEl?.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** Component for managing environment variable snippets. */
export class EnvSnippetManager {
  private containerEl: HTMLElement;
  private plugin: ClaudianPlugin;
  private onContextLimitsChange?: () => void;

  constructor(containerEl: HTMLElement, plugin: ClaudianPlugin, onContextLimitsChange?: () => void) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.onContextLimitsChange = onContextLimitsChange;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    // Header with save button
    const headerEl = this.containerEl.createDiv({ cls: 'claudian-snippet-header' });
    headerEl.createSpan({ text: 'Snippets', cls: 'claudian-snippet-label' });

    const saveBtn = headerEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Save current' },
    });
    setIcon(saveBtn, 'plus');
    saveBtn.addEventListener('click', () => this.saveCurrentEnv());

    const snippets = this.plugin.settings.envSnippets;

    if (snippets.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-snippet-empty' });
      emptyEl.setText('No saved environment snippets yet. Click "Save Current" to save your current environment configuration.');
      return;
    }

    // Use snippets as-is (maintain creation order)
    const sortedSnippets = snippets;

    const listEl = this.containerEl.createDiv({ cls: 'claudian-snippet-list' });

    for (const snippet of sortedSnippets) {
      const itemEl = listEl.createDiv({ cls: 'claudian-snippet-item' });

      const infoEl = itemEl.createDiv({ cls: 'claudian-snippet-info' });

      const nameEl = infoEl.createDiv({ cls: 'claudian-snippet-name' });
      nameEl.setText(snippet.name);

      if (snippet.description) {
        const descEl = infoEl.createDiv({ cls: 'claudian-snippet-description' });
        descEl.setText(snippet.description);
      }

      const actionsEl = itemEl.createDiv({ cls: 'claudian-snippet-actions' });

      // Restore button
      const restoreBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Insert' },
      });
      setIcon(restoreBtn, 'clipboard-paste');
      restoreBtn.addEventListener('click', async () => {
        try {
          await this.insertSnippet(snippet);
        } catch {
          new Notice('Failed to insert snippet');
        }
      });

      // Edit button
      const editBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Edit' },
      });
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', () => {
        this.editSnippet(snippet);
      });

      // Delete button
      const deleteBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
        attr: { 'aria-label': 'Delete' },
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', async () => {
        try {
          if (confirm(`Delete environment snippet "${snippet.name}"?`)) {
            await this.deleteSnippet(snippet);
          }
        } catch {
          new Notice('Failed to delete snippet');
        }
      });
    }
  }

  private async saveCurrentEnv() {
    const modal = new EnvSnippetModal(
      this.plugin.app,
      this.plugin,
      null,
      async (snippet) => {
        // Context limits are now handled by the modal itself
        this.plugin.settings.envSnippets.push(snippet);
        await this.plugin.saveSettings();
        this.render();
        new Notice(`Environment snippet "${snippet.name}" saved`);
      }
    );
    modal.open();
  }

  private async insertSnippet(snippet: EnvSnippet) {
    // Insert the snippet's environment variables into the input field
    const envTextarea = document.querySelector('.claudian-settings-env-textarea') as HTMLTextAreaElement;
    if (envTextarea) {
      // Always clear and replace with snippet content
      const snippetContent = snippet.envVars.trim();
      envTextarea.value = snippetContent;

      // Update settings with model reconciliation
      await this.plugin.applyEnvironmentVariables(snippetContent);

      // Restore context limits from snippet (if present)
      if (snippet.contextLimits) {
        this.plugin.settings.customContextLimits = { ...snippet.contextLimits };
      } else {
        // Clear context limits if snippet doesn't have them
        this.plugin.settings.customContextLimits = {};
      }
      await this.plugin.saveSettings();

      // Refresh context limits section
      this.onContextLimitsChange?.();

      // Trigger model selector refresh if it exists
      const view = this.plugin.app.workspace.getLeavesOfType('claudian-view')[0]?.view as ClaudianView | undefined;
      view?.refreshModelSelector();

    } else {
      // Fallback: directly replace in settings if textarea not found
      await this.plugin.applyEnvironmentVariables(snippet.envVars);

      // Restore context limits from snippet (if present)
      if (snippet.contextLimits) {
        this.plugin.settings.customContextLimits = { ...snippet.contextLimits };
      } else {
        this.plugin.settings.customContextLimits = {};
      }
      await this.plugin.saveSettings();

      this.render();

      // Refresh context limits section
      this.onContextLimitsChange?.();

      // Trigger model selector refresh if it exists
      const view = this.plugin.app.workspace.getLeavesOfType('claudian-view')[0]?.view as ClaudianView | undefined;
      view?.refreshModelSelector();

    }
  }

  private editSnippet(snippet: EnvSnippet) {
    const modal = new EnvSnippetModal(
      this.plugin.app,
      this.plugin,
      snippet,
      async (updatedSnippet) => {
        const index = this.plugin.settings.envSnippets.findIndex(s => s.id === snippet.id);
        if (index !== -1) {
          this.plugin.settings.envSnippets[index] = updatedSnippet;
          await this.plugin.saveSettings();
          this.render();
          new Notice(`Environment snippet "${updatedSnippet.name}" updated`);
        }
      }
    );
    modal.open();
  }

  private async deleteSnippet(snippet: EnvSnippet) {
    this.plugin.settings.envSnippets = this.plugin.settings.envSnippets.filter(s => s.id !== snippet.id);
    await this.plugin.saveSettings();
    this.render();
    new Notice(`Environment snippet "${snippet.name}" deleted`);
  }

  public refresh() {
    this.render();
  }
}
