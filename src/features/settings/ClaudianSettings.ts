/**
 * Claudian - Settings tab
 *
 * Plugin settings UI for hotkeys, customization, safety, and environment variables.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import { getCurrentPlatformKey, getHostnameKey } from '../../core/types';
import { DEFAULT_CLAUDE_MODELS } from '../../core/types/models';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n';
import type { Locale } from '../../i18n/types';
import type ClaudianPlugin from '../../main';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import type { ClaudianView } from '../chat/ClaudianView';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

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

    // Update i18n locale from settings
    setLocale(this.plugin.settings.locale);

    // Language selector at the very top
    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        const locales = getAvailableLocales();
        for (const locale of locales) {
          dropdown.addOption(locale, getLocaleDisplayName(locale));
        }
        dropdown
          .setValue(this.plugin.settings.locale)
          .onChange(async (value: Locale) => {
            if (!setLocale(value)) {
              // Invalid locale - reset dropdown to current value
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = value;
            await this.plugin.saveSettings();
            // Re-render the entire settings page with new language
            this.display();
          });
      });

    // Customization section
    new Setting(containerEl).setName(t('settings.customization')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
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
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
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
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
      });

    new Setting(containerEl)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
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
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          // Add "Auto" option (empty string = use default logic)
          dropdown.addOption('', t('settings.titleModel.auto'));

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
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
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
              new Notice(`${t('common.error')}: ${result.error}`);
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
    new Setting(containerEl).setName(t('settings.hotkeys')).setHeading();

    const inlineEditCommandId = 'claudian:inline-edit';
    const inlineEditHotkey = getHotkeyForCommand(this.app, inlineEditCommandId);
    new Setting(containerEl)
      .setName(t('settings.inlineEditHotkey.name'))
      .setDesc(inlineEditHotkey
        ? t('settings.inlineEditHotkey.descWithKey', { hotkey: inlineEditHotkey })
        : t('settings.inlineEditHotkey.descNoKey'))
      .addButton((button) =>
        button
          .setButtonText(inlineEditHotkey ? t('settings.inlineEditHotkey.btnChange') : t('settings.inlineEditHotkey.btnSet'))
          .onClick(() => openHotkeySettings(this.app))
      );

    const openChatCommandId = 'claudian:open-view';
    const openChatHotkey = getHotkeyForCommand(this.app, openChatCommandId);
    new Setting(containerEl)
      .setName(t('settings.openChatHotkey.name'))
      .setDesc(openChatHotkey
        ? t('settings.openChatHotkey.descWithKey', { hotkey: openChatHotkey })
        : t('settings.openChatHotkey.descNoKey'))
      .addButton((button) =>
        button
          .setButtonText(openChatHotkey ? t('settings.openChatHotkey.btnChange') : t('settings.openChatHotkey.btnSet'))
          .onClick(() => openHotkeySettings(this.app))
      );

    const newSessionCommandId = 'claudian:new-session';
    const newSessionHotkey = getHotkeyForCommand(this.app, newSessionCommandId);
    new Setting(containerEl)
      .setName(t('settings.newSessionHotkey.name'))
      .setDesc(newSessionHotkey
        ? t('settings.newSessionHotkey.descWithKey', { hotkey: newSessionHotkey })
        : t('settings.newSessionHotkey.descNoKey'))
      .addButton((button) =>
        button
          .setButtonText(newSessionHotkey ? t('settings.newSessionHotkey.btnChange') : t('settings.newSessionHotkey.btnSet'))
          .onClick(() => openHotkeySettings(this.app))
      );

    const newTabCommandId = 'claudian:new-tab';
    const newTabHotkey = getHotkeyForCommand(this.app, newTabCommandId);
    new Setting(containerEl)
      .setName(t('settings.newTabHotkey.name'))
      .setDesc(newTabHotkey
        ? t('settings.newTabHotkey.descWithKey', { hotkey: newTabHotkey })
        : t('settings.newTabHotkey.descNoKey'))
      .addButton((button) =>
        button
          .setButtonText(newTabHotkey ? t('settings.newTabHotkey.btnChange') : t('settings.newTabHotkey.btnSet'))
          .onClick(() => openHotkeySettings(this.app))
      );

    const closeTabCommandId = 'claudian:close-current-tab';
    const closeTabHotkey = getHotkeyForCommand(this.app, closeTabCommandId);
    new Setting(containerEl)
      .setName(t('settings.closeTabHotkey.name'))
      .setDesc(closeTabHotkey
        ? t('settings.closeTabHotkey.descWithKey', { hotkey: closeTabHotkey })
        : t('settings.closeTabHotkey.descNoKey'))
      .addButton((button) =>
        button
          .setButtonText(closeTabHotkey ? t('settings.closeTabHotkey.btnChange') : t('settings.closeTabHotkey.btnSet'))
          .onClick(() => openHotkeySettings(this.app))
      );

    // Slash Commands section
    new Setting(containerEl).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'claudian-slash-settings-desc' });
    slashCommandsDesc.createEl('p', {
      text: t('settings.slashCommands.desc'),
      cls: 'setting-item-description',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    // MCP Servers section
    new Setting(containerEl).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = containerEl.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = containerEl.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

    // Claude Code Plugins section
    new Setting(containerEl).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = containerEl.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = containerEl.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, this.plugin);

    // Safety section
    new Setting(containerEl).setName(t('settings.safety')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.loadUserClaudeSettings)
          .onChange(async (value) => {
            this.plugin.settings.loadUserClaudeSettings = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.enableBlocklist.name'))
      .setDesc(t('settings.enableBlocklist.desc'))
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
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
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
        .setName(t('settings.blockedCommands.unixName'))
        .setDesc(t('settings.blockedCommands.unixDesc'))
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
      .setName(t('settings.exportPaths.name'))
      .setDesc(t('settings.exportPaths.desc'))
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

    // Environment Variables section
    new Setting(containerEl).setName(t('settings.environment')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.customVariables.name'))
      .setDesc(t('settings.customVariables.desc'))
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
    new Setting(containerEl).setName(t('settings.advanced')).setHeading();

    // 1M context model toggle
    new Setting(containerEl)
      .setName(t('settings.show1MModel.name'))
      .setDesc(t('settings.show1MModel.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.show1MModel ?? false)
          .onChange(async (value) => {
            this.plugin.settings.show1MModel = value;
            await this.plugin.saveSettings();

            // Refresh model selector to show/hide model options
            const view = this.plugin.app.workspace.getLeavesOfType('claudian-view')[0]?.view as ClaudianView | undefined;
            view?.refreshModelSelector();
          })
      );

    // Max tabs setting
    const maxTabsSetting = new Setting(containerEl)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    // Warning element for high tab count
    const maxTabsWarningEl = containerEl.createDiv({ cls: 'claudian-max-tabs-warning' });
    maxTabsWarningEl.style.color = 'var(--text-warning)';
    maxTabsWarningEl.style.fontSize = '0.85em';
    maxTabsWarningEl.style.marginTop = '-0.5em';
    maxTabsWarningEl.style.marginBottom = '0.5em';
    maxTabsWarningEl.style.display = 'none';
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.style.display = value > 5 ? 'block' : 'none';
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTabs = value;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(value);
        });
      // Show warning on initial load if needed
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    // Get hostname key for per-device CLI path storage
    const hostnameKey = getHostnameKey();

    // Build description with hostname info
    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(containerEl)
      .setName(`${t('settings.cliPath.name')} (${hostnameKey})`)
      .setDesc(cliPathDescription);

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
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    cliPathSetting.addText((text) => {
      // Platform-aware placeholder
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';

      // Read from hostname-specific path
      const currentValue = this.plugin.settings.claudeCliPathsByHost?.[hostnameKey] || '';

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
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

          const trimmed = value.trim();
          // Initialize claudeCliPathsByHost if needed
          if (!this.plugin.settings.claudeCliPathsByHost) {
            this.plugin.settings.claudeCliPathsByHost = {};
          }
          // Write to hostname-specific path
          this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmed;
          await this.plugin.saveSettings();
          // Clear cached path so next query will use the new path
          this.plugin.cliResolver?.reset();
          // Cleanup all tab services so they restart with the new CLI path
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      // Validate on initial load
      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });
  }

}
