/**
 * Claudian - Settings tab
 *
 * Plugin settings UI for hotkeys, customization, safety, and environment variables.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import { getCurrentPlatformKey } from '../../core/types';
import { DEFAULT_CLAUDE_MODELS } from '../../core/types/models';
import type ClaudianPlugin from '../../main';
import { EnvSnippetManager, McpSettingsManager, SlashCommandSettings } from '../../ui';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';

/** Format a hotkey for display (e.g., "Cmd+Shift+E" on Mac, "Ctrl+Shift+E" on Windows). */
function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

/** Open Obsidian's hotkey settings filtered to Claudian commands. */
function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
  // Slight delay to ensure the tab is loaded
  setTimeout(() => {
    const tab = setting.activeTab;
    if (tab) {
      // Handle both old and new Obsidian versions
      const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
      if (searchEl) {
        searchEl.value = 'Claudian';
        tab.updateHotkeyVisibility?.();
      }
    }
  }, 100);
}

/** Get the current hotkey string for a command, or null if not set. */
function getHotkeyForCommand(app: App, commandId: string): string | null {
  // Access Obsidian's internal hotkey manager
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  // Get custom hotkeys first, then fall back to defaults
  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

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

    new Setting(containerEl)
      .setName('Auto-generate conversation titles')
      .setDesc('Automatically generate conversation titles after the first exchange.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(containerEl)
        .setName('Title generation model')
        .setDesc('Model used for auto-generating conversation titles.')
        .addDropdown((dropdown) => {
          // Add "Auto" option (empty string = use default logic)
          dropdown.addOption('', 'Auto (Haiku)');

          // Get available models from environment or defaults
          const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
          const customModels = getModelsFromEnvironment(envVars);
          const models = customModels.length > 0 ? customModels : DEFAULT_CLAUDE_MODELS;

          for (const model of models) {
            dropdown.addOption(model.value, model.label);
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName('Vim-style navigation mappings')
      .setDesc('One mapping per line. Format: "map <key> <action>" (actions: scrollUp, scrollDown, focusInput).')
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`Invalid navigation mappings: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('map w scrollUp\nmap s scrollDown\nmap i focusInput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', async () => {
          await commitValue(true);
        });
      });

    // Hotkeys section
    new Setting(containerEl).setName('Hotkeys').setHeading();

    const inlineEditCommandId = 'claudian:inline-edit';
    const inlineEditHotkey = getHotkeyForCommand(this.app, inlineEditCommandId);
    new Setting(containerEl)
      .setName('Inline edit hotkey')
      .setDesc(inlineEditHotkey
        ? `Current: ${inlineEditHotkey}`
        : 'No hotkey set. Click to configure.')
      .addButton((button) =>
        button
          .setButtonText(inlineEditHotkey ? 'Change' : 'Set hotkey')
          .onClick(() => openHotkeySettings(this.app))
      );

    const openChatCommandId = 'claudian:open-chat';
    const openChatHotkey = getHotkeyForCommand(this.app, openChatCommandId);
    new Setting(containerEl)
      .setName('Open chat hotkey')
      .setDesc(openChatHotkey
        ? `Current: ${openChatHotkey}`
        : 'No hotkey set. Click to configure.')
      .addButton((button) =>
        button
          .setButtonText(openChatHotkey ? 'Change' : 'Set hotkey')
          .onClick(() => openHotkeySettings(this.app))
      );

    // Slash Commands section
    new Setting(containerEl).setName('Slash Commands').setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'claudian-slash-settings-desc' });
    slashCommandsDesc.createEl('p', {
      text: 'Create custom prompt templates triggered by /command. Use $ARGUMENTS for all arguments, $1/$2 for positional args, @file for file content, and !`bash` for command output.',
      cls: 'setting-item-description',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    // MCP Servers section
    new Setting(containerEl).setName('MCP Servers').setHeading();

    const mcpDesc = containerEl.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: 'Configure Model Context Protocol servers to extend Claude\'s capabilities with external tools and data sources. Servers with context-saving mode require @mention to activate.',
      cls: 'setting-item-description',
    });

    const mcpContainer = containerEl.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

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
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(`Blocked commands (${platformLabel})`)
      .setDesc(`Patterns to block on ${platformLabel} (one per line). Supports regex.`)
      .addTextArea((text) => {
        // Platform-aware placeholder
        const placeholder = isWindows
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

    // On Windows, show Unix blocklist too since Git Bash can run Unix commands
    if (isWindows) {
      new Setting(containerEl)
        .setName('Blocked commands (Unix/Git Bash)')
        .setDesc('Unix patterns also blocked on Windows because Git Bash can invoke them.')
        .addTextArea((text) => {
          text
            .setPlaceholder('rm -rf\nchmod 777\nmkfs')
            .setValue(this.plugin.settings.blockedCommands.unix.join('\n'))
            .onChange(async (value) => {
              this.plugin.settings.blockedCommands.unix = value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 4;
          text.inputEl.cols = 40;
        });
    }

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

    // Advanced section
    new Setting(containerEl).setName('Advanced').setHeading();

    const cliPathSetting = new Setting(containerEl)
      .setName('Claude CLI path')
      .setDesc('Custom path to Claude Code CLI. Leave empty for auto-detection. Use cli.js path on Windows for npm installations.');

    // Create validation message element
    const validationEl = containerEl.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null; // Empty is valid (auto-detect)

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return 'Path does not exist';
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return 'Path is a directory, not a file';
      }
      return null;
    };

    cliPathSetting.addText((text) => {
      // Platform-aware placeholder
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
      text
        .setPlaceholder(placeholder)
        .setValue(this.plugin.settings.claudeCliPath || '')
        .onChange(async (value) => {
          const error = validatePath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.style.display = 'block';
            text.inputEl.style.borderColor = 'var(--text-error)';
          } else {
            validationEl.style.display = 'none';
            text.inputEl.style.borderColor = '';
          }

          this.plugin.settings.claudeCliPath = value.trim();
          await this.plugin.saveSettings();
          // Clear cached path so next query will use the new path
          this.plugin.agentService?.cleanup();
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      // Validate on initial load
      const initialError = validatePath(this.plugin.settings.claudeCliPath || '');
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });
  }
}
