import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import {
  getHiddenProviderCommands,
  normalizeHiddenCommandList,
} from '../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { ProviderId } from '../../core/providers/types';
import { getCurrentPlatformKey } from '../../core/types';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n/i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import type ClaudianPlugin from '../../main';
import { findNodeExecutable, formatContextLimit, getEnhancedPath, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import { getHostnameKey } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { ClaudianView } from '../chat/ClaudianView';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { AgentSettings } from './ui/AgentSettings';
import { CodexSkillSettings } from './ui/CodexSkillSettings';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

type SettingsTabId = 'general' | 'claude' | 'codex';

function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
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

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({ cls: 'claudian-hotkey-name', text: t(`${translationPrefix}.name` as TranslationKey) });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;
  private contextLimitsContainer: HTMLElement | null = null;
  private activeTab: SettingsTabId = 'general';

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private normalizeModelVariantSettings(): void {
    this.plugin.normalizeModelVariantSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');

    setLocale(this.plugin.settings.locale as Locale);

    // -- Tab bar --
    const tabBar = containerEl.createDiv({ cls: 'claudian-settings-tabs' });
    const tabIds: SettingsTabId[] = ['general', 'claude', 'codex'];
    const tabButtons: Record<string, HTMLButtonElement> = {};
    const tabContents: Record<string, HTMLDivElement> = {};

    for (const id of tabIds) {
      const btn = tabBar.createEl('button', {
        cls: `claudian-settings-tab${id === this.activeTab ? ' claudian-settings-tab--active' : ''}`,
        text: t(`settings.tabs.${id}` as TranslationKey),
      });
      btn.addEventListener('click', () => {
        this.activeTab = id;
        for (const tid of tabIds) {
          tabButtons[tid].toggleClass('claudian-settings-tab--active', tid === id);
          tabContents[tid].toggleClass('claudian-settings-tab-content--active', tid === id);
        }
      });
      tabButtons[id] = btn;
    }

    for (const id of tabIds) {
      const content = containerEl.createDiv({
        cls: `claudian-settings-tab-content${id === this.activeTab ? ' claudian-settings-tab-content--active' : ''}`,
      });
      tabContents[id] = content;
    }

    // -- Render tab contents --
    this.renderGeneralTab(tabContents['general']);
    this.renderClaudeTab(tabContents['claude']);
    this.renderCodexTab(tabContents['codex']);
  }

  // ── General tab ──

  private renderGeneralTab(container: HTMLElement): void {
    new Setting(container)
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
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(container)
      .setName('Enable Codex provider')
      .setDesc('When enabled, Codex models appear in the model selector for new conversations. Existing Codex sessions are always preserved.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.codexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.codexEnabled = value;
            await this.plugin.saveSettings();
            for (const view of this.plugin.getAllViews()) {
              view.refreshModelSelector();
            }
            this.display();
          })
      );

    new Setting(container).setName(t('settings.customization')).setHeading();

    new Setting(container)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(container)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(container)
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
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(container)
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
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(container)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
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
      new Setting(container)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('', t('settings.titleModel.auto'));

          // Collect models from all registered providers
          const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
          const seenValues = new Set<string>();
          for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
            const uiConfig = ProviderRegistry.getChatUIConfig(providerId as ProviderId);
            for (const model of uiConfig.getModelOptions(settingsBag)) {
              if (!seenValues.has(model.value)) {
                seenValues.add(model.value);
                dropdown.addOption(model.value, model.label);
              }
            }
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(container)
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

    new Setting(container)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value: 'input' | 'header') => {
            this.plugin.settings.tabBarPosition = value;
            await this.plugin.saveSettings();

            for (const leaf of this.plugin.app.workspace.getLeavesOfType('claudian-view')) {
              if (leaf.view instanceof ClaudianView) {
                leaf.view.updateLayoutForPosition();
              }
            }
          });
      });

    new Setting(container)
      .setName(t('settings.openInMainTab.name'))
      .setDesc(t('settings.openInMainTab.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInMainTab)
          .onChange(async (value) => {
            this.plugin.settings.openInMainTab = value;
            await this.plugin.saveSettings();
          })
      );

    const maxTabsSetting = new Setting(container)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = container.createDiv({ cls: 'claudian-max-tabs-warning' });
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
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    new Setting(container).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = container.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');

    new Setting(container).setName(t('settings.safety')).setHeading();

    new Setting(container)
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

    new Setting(container)
      .setName(t('settings.allowExternalAccess.name'))
      .setDesc(t('settings.allowExternalAccess.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowExternalAccess)
          .onChange(async (value) => {
            this.plugin.settings.allowExternalAccess = value;
            await this.plugin.saveSettings();
            this.display();
            await this.restartServiceForPromptChange();
          })
      );

    const platformKey = getCurrentPlatformKey();
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(container)
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
      .addTextArea((text) => {
        const placeholder = isWindows
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    if (isWindows) {
      new Setting(container)
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

    new Setting(container)
      .setName(t('settings.exportPaths.name'))
      .setDesc(
        this.plugin.settings.allowExternalAccess
          ? t('settings.exportPaths.disabledDesc')
          : t('settings.exportPaths.desc')
      )
      .addTextArea((text) => {
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .setDisabled(this.plugin.settings.allowExternalAccess)
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

  }

  // ── Claude tab ──

  private renderClaudeTab(container: HTMLElement): void {
    new Setting(container).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
    descP.appendText(t('settings.slashCommands.desc') + ' ');
    descP.createEl('a', {
      text: 'Learn more',
      href: 'https://code.claude.com/docs/en/skills',
    });

    const slashCommandsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    this.renderHiddenProviderCommandSetting(container, 'claude', {
      name: t('settings.hiddenSlashCommands.name'),
      desc: t('settings.hiddenSlashCommands.desc'),
      placeholder: t('settings.hiddenSlashCommands.placeholder'),
    });

    new Setting(container).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = container.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, this.plugin);

    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = container.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

    new Setting(container).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = container.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = container.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, this.plugin);

    new Setting(container).setName(t('settings.environment')).setHeading();

    new Setting(container)
      .setName(t('settings.customVariables.name'))
      .setDesc(t('settings.customVariables.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model')
          .setValue(this.plugin.settings.environmentVariables);
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('claudian-settings-env-textarea');
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.applyEnvironmentVariables(text.inputEl.value);
          this.renderContextLimitsSection();
        });
      });

    this.contextLimitsContainer = container.createDiv({ cls: 'claudian-context-limits-container' });
    this.renderContextLimitsSection();

    const envSnippetsContainer = container.createDiv({ cls: 'claudian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin, () => {
      this.renderContextLimitsSection();
    });

    new Setting(container).setName(t('settings.safety')).setHeading();

    new Setting(container)
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

    new Setting(container).setName(t('settings.advanced')).setHeading();

    new Setting(container)
      .setName(t('settings.enableOpus1M.name'))
      .setDesc(t('settings.enableOpus1M.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableOpus1M ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableOpus1M = value;
            this.normalizeModelVariantSettings();
            await this.plugin.saveSettings();
            for (const view of this.plugin.getAllViews()) {
              view.refreshModelSelector();
            }
            this.display();
          })
      );

    new Setting(container)
      .setName(t('settings.enableSonnet1M.name'))
      .setDesc(t('settings.enableSonnet1M.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSonnet1M ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableSonnet1M = value;
            this.normalizeModelVariantSettings();
            await this.plugin.saveSettings();
            for (const view of this.plugin.getAllViews()) {
              view.refreshModelSelector();
            }
            this.display();
          })
      );

    new Setting(container)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableChrome ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableChrome = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBangBash ?? false)
          .onChange(async (value) => {
            bangBashValidationEl.style.display = 'none';
            if (value) {
              const enhancedPath = getEnhancedPath();
              const nodePath = findNodeExecutable(enhancedPath);
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.style.display = 'block';
                toggle.setValue(false);
                return;
              }
            }
            this.plugin.settings.enableBangBash = value;
            await this.plugin.saveSettings();
          })
      );

    const bangBashValidationEl = container.createDiv({ cls: 'claudian-bang-bash-validation' });
    bangBashValidationEl.style.color = 'var(--text-error)';
    bangBashValidationEl.style.fontSize = '0.85em';
    bangBashValidationEl.style.marginTop = '-0.5em';
    bangBashValidationEl.style.marginBottom = '0.5em';
    bangBashValidationEl.style.display = 'none';

    const hostnameKey = getHostnameKey();

    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(container)
      .setName(`${t('settings.cliPath.name')} (${hostnameKey})`)
      .setDesc(cliPathDescription);

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

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
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';

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
          if (!this.plugin.settings.claudeCliPathsByHost) {
            this.plugin.settings.claudeCliPathsByHost = {};
          }
          this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmed;
          await this.plugin.saveSettings();
          this.plugin.cliResolver?.reset();
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });
  }

  // ── Codex tab ──

  private renderCodexTab(container: HTMLElement): void {
    const hostnameKey = getHostnameKey();
    const platformHint = process.platform === 'win32'
      ? 'Use the local `codex.exe` path from your Codex CLI installation.'
      : 'Paste the output of `which codex` from a terminal where Codex works.';

    const cliPathSetting = new Setting(container)
      .setName(`Codex CLI path (${hostnameKey})`)
      .setDesc(`Custom path to the local Codex CLI. Leave empty for auto-detection from PATH. ${platformHint}`);

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

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

    const currentValue = this.plugin.settings.codexCliPathsByHost?.[hostnameKey] || '';

    cliPathSetting.addText((text) => {
      const placeholder = process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe'
        : '/opt/homebrew/bin/codex';

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
          if (!this.plugin.settings.codexCliPathsByHost) {
            this.plugin.settings.codexCliPathsByHost = {};
          }

          if (trimmed) {
            this.plugin.settings.codexCliPathsByHost[hostnameKey] = trimmed;
          } else {
            delete this.plugin.settings.codexCliPathsByHost[hostnameKey];
          }
          await this.plugin.saveSettings();
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });

    // Reasoning summary
    const SUMMARY_OPTIONS: { value: string; label: string }[] = [
      { value: 'concise', label: 'Concise' },
      { value: 'detailed', label: 'Detailed' },
      { value: 'none', label: 'Off' },
    ];

    new Setting(container)
      .setName('Reasoning summary')
      .setDesc('Show a summary of the model\'s reasoning process in the thinking block.')
      .addDropdown((dropdown) => {
        for (const opt of SUMMARY_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown.setValue(this.plugin.settings.codexReasoningSummary ?? 'concise');
        dropdown.onChange(async (value) => {
          this.plugin.settings.codexReasoningSummary = value;
          await this.plugin.saveSettings();
        });
      });

    // Codex Skills (vault-only)
    const codexCatalog = ProviderRegistry.getCommandCatalog('codex');
    if (codexCatalog) {
      new Setting(container).setName('Codex Skills').setHeading();

      const skillsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      skillsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: 'Manage vault-level Codex skills stored in .codex/skills/ or .agents/skills/. Home-level skills are excluded here.',
      });

      const skillsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new CodexSkillSettings(skillsContainer, codexCatalog, this.plugin.app);
    }

    this.renderHiddenProviderCommandSetting(container, 'codex', {
      name: 'Hidden Skills',
      desc: 'Hide specific Codex skills from the dropdown. Enter skill names without the leading $, one per line.',
      placeholder: 'analyze\nexplain\nfix',
    });

    // MCP Servers (informational)
    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();
    const mcpNotice = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    const mcpDesc = mcpNotice.createEl('p', { cls: 'setting-item-description' });
    mcpDesc.appendText('Codex manages MCP servers via its own CLI. Configure with ');
    mcpDesc.createEl('code', { text: 'codex mcp' });
    mcpDesc.appendText(' and they will be available in Claudian. ');
    mcpDesc.createEl('a', {
      text: 'Learn more',
      href: 'https://developers.openai.com/codex/mcp',
    });
  }

  // ── Shared helpers ──

  private renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void {
    new Setting(container)
      .setName(copy.name)
      .setDesc(copy.desc)
      .addTextArea((text) => {
        text
          .setPlaceholder(copy.placeholder)
          .setValue(getHiddenProviderCommands(this.plugin.settings, providerId).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenProviderCommands = {
              ...this.plugin.settings.hiddenProviderCommands,
              [providerId]: normalizeHiddenCommandList(value.split(/\r?\n/)),
            };
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenProviderCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });
  }

  private renderContextLimitsSection(): void {
    const container = this.contextLimitsContainer;
    if (!container) return;

    container.empty();

    const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
    const uniqueModelIds = ProviderRegistry.getChatUIConfig().getCustomModelIds(envVars);

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({ text: t('settings.customContextLimits.name'), cls: 'claudian-context-limits-label' });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customContextLimits.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });

      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });

      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation' });

      inputEl.addEventListener('input', async () => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.style.display = 'block';
            inputEl.classList.add('claudian-input-error');
            return;
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        }

        await this.plugin.saveSettings();
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Silently ignore restart failures - changes will apply on next conversation
    }
  }

}
