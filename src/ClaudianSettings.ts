/**
 * Claudian - Settings tab
 *
 * Plugin settings UI for hotkeys, customization, safety, and environment variables.
 */

import type { App} from 'obsidian';
import { PluginSettingTab, Setting } from 'obsidian';

import type ClaudianPlugin from './main';
import { getCurrentPlatformKey } from './types';
import { EnvSnippetManager, SlashCommandSettings } from './ui';

/** Plugin settings tab displayed in Obsidian's settings pane. */
export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');

    // Hotkeys section
    new Setting(containerEl).setName('Hotkeys').setHeading();

    new Setting(containerEl)
      .setName('Inline edit hotkey')
      .setDesc('Configure the keyboard shortcut for inline editing selected text')
      .addButton((button) =>
        button
          .setButtonText('Configure hotkey')
          .onClick(() => {
            // Open Obsidian's hotkey settings, filtered to our command
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById('hotkeys');
            // Slight delay to ensure the tab is loaded
            setTimeout(() => {
              const searchEl = document.querySelector('.hotkey-search-container input') as HTMLInputElement;
              if (searchEl) {
                searchEl.value = 'Claudian: Inline edit';
                searchEl.dispatchEvent(new Event('input'));
              }
            }, 100);
          })
      );

    new Setting(containerEl)
      .setName('Open chat hotkey')
      .setDesc('Configure the keyboard shortcut for opening the Claudian chat panel')
      .addButton((button) =>
        button
          .setButtonText('Configure hotkey')
          .onClick(() => {
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById('hotkeys');
            setTimeout(() => {
              const searchEl = document.querySelector('.hotkey-search-container input') as HTMLInputElement;
              if (searchEl) {
                searchEl.value = 'Claudian: Open chat';
                searchEl.dispatchEvent(new Event('input'));
              }
            }, 100);
          })
      );

    // Customization section
    new Setting(containerEl).setName('Customization').setHeading();

    new Setting(containerEl)
      .setName('What should Claudian call you?')
      .setDesc('Your name for personalized greetings (leave empty for generic greetings)')
      .addText((text) =>
        text
          .setPlaceholder('Enter your name')
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          })
      );

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
      .setName('Expand tool calls during streaming')
      .setDesc('When enabled, tool call blocks start expanded during streaming. History tool calls remain collapsed.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.toolCallExpandedByDefault)
          .onChange(async (value) => {
            this.plugin.settings.toolCallExpandedByDefault = value;
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
              .split(/\r?\n/)  // Handle both Unix (LF) and Windows (CRLF) line endings
              .map((s) => s.trim().replace(/^#/, ''))  // Remove leading # if present
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName('Media folder')
      .setDesc('Folder containing attachments/images. When notes use ![[image.jpg]], Claude will look here. Leave empty for vault root.')
      .addText((text) => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('claudian-settings-media-input');
      });

    new Setting(containerEl)
      .setName('Custom system prompt')
      .setDesc('Additional instructions appended to the default system prompt')
      .addTextArea((text) => {
        text
          .setPlaceholder('Add custom instructions here...')
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
      });

    // Slash Commands section
    new Setting(containerEl).setName('Slash Commands').setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'claudian-slash-settings-desc' });
    slashCommandsDesc.createEl('p', {
      text: 'Create custom prompt templates triggered by /command. Use $ARGUMENTS for all arguments, $1/$2 for positional args, @file for file content, and !`bash` for command output.',
      cls: 'setting-item-description',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    // Safety section
    new Setting(containerEl).setName('Safety').setHeading();

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

    const platformKey = getCurrentPlatformKey();
    const platformLabel = platformKey === 'windows' ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(`Blocked commands (${platformLabel})`)
      .setDesc(`Patterns to block on ${platformLabel} (one per line). Supports regex. Each platform has its own list.`)
      .addTextArea((text) => {
        // Platform-aware placeholder
        const placeholder = platformKey === 'windows'
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)  // Handle both Unix (LF) and Windows (CRLF) line endings
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName('Allowed export paths')
      .setDesc('Paths outside the vault where files can be exported (one per line). Supports ~ for home directory.')
      .addTextArea((text) => {
        // Platform-aware placeholder
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)  // Handle both Unix (LF) and Windows (CRLF) line endings
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
      });

    const approvedDesc = containerEl.createDiv({ cls: 'claudian-approved-desc' });
    approvedDesc.createEl('p', {
      text: 'Actions that have been permanently approved (via "Always Allow"). These will not require approval in Safe mode.',
      cls: 'setting-item-description',
    });

    const permissions = this.plugin.settings.permissions;

    if (permissions.length === 0) {
      const emptyEl = containerEl.createDiv({ cls: 'claudian-approved-empty' });
      emptyEl.setText('No approved actions yet. When you click "Always Allow" in the approval dialog, actions will appear here.');
    } else {
      const listEl = containerEl.createDiv({ cls: 'claudian-approved-list' });

      for (const action of permissions) {
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
          this.plugin.settings.permissions =
            this.plugin.settings.permissions.filter((a) => a !== action);
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
            .setButtonText('Clear all')
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.permissions = [];
              await this.plugin.saveSettings();
              this.display(); // Refresh
            })
        );
    }

    // Environment Variables section
    new Setting(containerEl).setName('Environment').setHeading();

    new Setting(containerEl)
      .setName('Custom variables')
      .setDesc('Environment variables for Claude SDK (KEY=VALUE format, one per line)')
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

    // Environment Snippets subsection
    const envSnippetsContainer = containerEl.createDiv({ cls: 'claudian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin);
  }
}
