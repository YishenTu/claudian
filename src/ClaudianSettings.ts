import { App, PluginSettingTab, Setting } from 'obsidian';
import type ClaudianPlugin from './main';
import { getVaultPath } from './utils';
import { EnvSnippetManager } from './ui';

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Claudian Settings' });

    // Safety section
    containerEl.createEl('h3', { text: 'Safety' });

    new Setting(containerEl)
      .setName('Enable command blocklist')
      .setDesc('Block potentially dangerous bash commands')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlocklist)
          .onChange(async (value) => {
            this.plugin.settings.enableBlocklist = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Blocked commands')
      .setDesc('Patterns to block (one per line). Supports regex.')
      .addTextArea((text) => {
        text
          .setPlaceholder('rm -rf\nchmod 777\nmkfs')
          .setValue(this.plugin.settings.blockedCommands.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands = value
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    // UI section
    containerEl.createEl('h3', { text: 'Interface' });

    new Setting(containerEl)
      .setName('Show tool usage')
      .setDesc('Display when Claude reads, writes, or edits files')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showToolUse)
          .onChange(async (value) => {
            this.plugin.settings.showToolUse = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Excluded tags')
      .setDesc('Notes with these tags will not auto-load as context (one per line, without #)')
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split('\n')
              .map((s) => s.trim().replace(/^#/, ''))  // Remove leading # if present
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName('Environment variables')
      .setDesc('Custom environment variables for Claude (KEY=VALUE format, one per line)')
      .addTextArea((text) => {
        text
          .setPlaceholder('ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model')
          .setValue(this.plugin.settings.environmentVariables)
          .onChange(async (value) => {
            await this.plugin.applyEnvironmentVariables(value);
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('claudian-settings-env-textarea');
      });

    // Environment Snippets section
    const envSnippetsContainer = containerEl.createDiv({ cls: 'claudian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin);

    // Approved Actions section
    containerEl.createEl('h3', { text: 'Approved Actions' });

    const approvedDesc = containerEl.createDiv({ cls: 'claudian-approved-desc' });
    approvedDesc.createEl('p', {
      text: 'Actions that have been permanently approved (via "Always Allow"). These will not require approval in Safe mode.',
      cls: 'setting-item-description',
    });

    const approvedActions = this.plugin.settings.approvedActions;

    if (approvedActions.length === 0) {
      const emptyEl = containerEl.createDiv({ cls: 'claudian-approved-empty' });
      emptyEl.setText('No approved actions yet. When you click "Always Allow" in the approval dialog, actions will appear here.');
    } else {
      const listEl = containerEl.createDiv({ cls: 'claudian-approved-list' });

      for (const action of approvedActions) {
        const itemEl = listEl.createDiv({ cls: 'claudian-approved-item' });

        const infoEl = itemEl.createDiv({ cls: 'claudian-approved-item-info' });

        const toolEl = infoEl.createSpan({ cls: 'claudian-approved-item-tool' });
        toolEl.setText(action.toolName);

        const patternEl = infoEl.createDiv({ cls: 'claudian-approved-item-pattern' });
        patternEl.setText(action.pattern);

        const dateEl = infoEl.createSpan({ cls: 'claudian-approved-item-date' });
        dateEl.setText(new Date(action.approvedAt).toLocaleDateString());

        const removeBtn = itemEl.createEl('button', {
          text: 'Remove',
          cls: 'claudian-approved-remove-btn',
        });
        removeBtn.addEventListener('click', async () => {
          this.plugin.settings.approvedActions =
            this.plugin.settings.approvedActions.filter((a) => a !== action);
          await this.plugin.saveSettings();
          this.display(); // Refresh
        });
      }

      // Clear all button
      new Setting(containerEl)
        .setName('Clear all approved actions')
        .setDesc('Remove all permanently approved actions')
        .addButton((button) =>
          button
            .setButtonText('Clear All')
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.approvedActions = [];
              await this.plugin.saveSettings();
              this.display(); // Refresh
            })
        );
    }

    // Info section
    containerEl.createEl('h3', { text: 'Information' });

    const infoDiv = containerEl.createDiv({ cls: 'claudian-info' });
    infoDiv.createEl('p', {
      text: 'This plugin uses the Claude Agent SDK to interact with Claude.',
    });

    const vaultPath = getVaultPath(this.app);
    if (vaultPath) {
      infoDiv.createEl('p', {
        text: `Vault path: ${vaultPath}`,
        cls: 'claudian-vault-path',
      });
    }
  }
}
