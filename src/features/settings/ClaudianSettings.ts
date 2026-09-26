import type { App, Plugin, SettingDefinitionItem } from 'obsidian';
import { Notice, Platform, PluginSettingTab, Setting } from 'obsidian';

import { frameSettingsGroups } from '@/shared/settings/SettingsGroups';

import {
  getHiddenProviderCommands,
  normalizeHiddenCommandList,
} from '../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderId, ProviderSettingsTabRenderHandle } from '../../core/providers/types';
import { AgentSkillRepository } from '../../core/skills/AgentSkillRepository';
import type {
  ChatViewPlacement,
  DualPaneSide,
} from '../../core/types/settings';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n/i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import { renderEnvironmentSettingsSection } from '../../shared/settings/EnvironmentSettingsSection';
import { formatContextLimit, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import {
  MAX_WARM_AGENT_PROCESSES,
  MIN_WARM_AGENT_PROCESSES,
} from '../chat/execution/WarmExecutionPool';
import type { FeatureHost } from '../FeatureHost';
import { AgentSkillManagementCoordinator } from './AgentSkillManagementCoordinator';
import { AgentSkillSettings } from './AgentSkillSettings';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';

type SettingsTabId = 'general' | 'providers';
type ObsidianHotkey = { modifiers: string[]; key: string };
type ObsidianHotkeyManager = {
  customKeys?: Record<string, ObsidianHotkey[] | undefined>;
  defaultKeys?: Record<string, ObsidianHotkey[] | undefined>;
};
type ObsidianHotkeyTab = {
  searchInputEl?: HTMLInputElement;
  searchComponent?: { inputEl?: HTMLInputElement };
  updateHotkeyVisibility?: () => void;
};
type ObsidianSettingsController = {
  activeTab?: ObsidianHotkeyTab;
  open: () => void;
  openTabById: (id: string) => void;
};
type AppWithHotkeyInternals = App & {
  hotkeyManager?: ObsidianHotkeyManager;
  setting?: ObsidianSettingsController;
};

function formatHotkey(hotkey: ObsidianHotkey): string {
  const isMac = Platform.isMacOS;
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((modifier) => modMap[modifier] || modifier);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as AppWithHotkeyInternals).setting;
  if (!setting) {
    return;
  }

  setting.open();
  setting.openTabById('hotkeys');
  window.setTimeout(() => {
    const tab = setting.activeTab;
    if (!tab) {
      return;
    }

    const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
    if (!searchEl) {
      return;
    }

    searchEl.value = 'Claudian';
    tab.updateHotkeyVisibility?.();
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as AppWithHotkeyInternals).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys && customHotkeys.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string,
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({
    cls: 'claudian-hotkey-name',
    text: t(`${translationPrefix}.name` as TranslationKey),
  });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: FeatureHost;
  private activeTab: SettingsTabId = 'general';
  private activeProviderTab: ProviderId | null = null;
  private refreshTitleModelOptions: (() => void) | null = null;
  private renderGeneration = 0;
  private readonly providerSettingsRenders = new Map<ProviderId, ProviderSettingsTabRenderHandle>();
  private readonly agentSkillCoordinator: AgentSkillManagementCoordinator;

  constructor(app: App, plugin: FeatureHost & Plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.agentSkillCoordinator = new AgentSkillManagementCoordinator(
      new AgentSkillRepository(plugin.storage.getAdapter()),
      () => plugin.notifyAgentSkillsChanged(),
    );
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: 'Claudian',
      searchable: false,
      render: setting => this.renderSettings(setting.settingEl),
    }];
  }

  private renderSettings(containerEl: HTMLElement): () => void {
    this.disposeProviderSettingsRenders();
    const renderGeneration = ++this.renderGeneration;
    this.agentSkillCoordinator.resetSubscriptions();
    containerEl.empty();
    containerEl.addClass('claudian-settings');
    const settingItems = containerEl.parentElement;
    if (settingItems?.classList.contains('setting-items')) {
      settingItems.classList.add('claudian-settings-items');
    }
    this.refreshTitleModelOptions = null;

    setLocale(this.plugin.settings.locale as Locale);

    const providerTabs = ProviderRegistry.getRegisteredProviderIds();
    const tabIds: SettingsTabId[] = ['general', 'providers'];
    const preferredProvider = providerTabs.includes(this.plugin.settings.settingsProvider)
      ? this.plugin.settings.settingsProvider
      : providerTabs[0] ?? null;
    if (!this.activeProviderTab || !providerTabs.includes(this.activeProviderTab)) {
      this.activeProviderTab = preferredProvider;
    }

    const tabBar = containerEl.createDiv({ cls: 'claudian-settings-tabs' });
    const tabButtons = new Map<SettingsTabId, HTMLButtonElement>();
    const tabContents = new Map<SettingsTabId, HTMLDivElement>();
    const providersContent = containerEl.createDiv({
      cls: `claudian-settings-tab-content${this.activeTab === 'providers' ? ' claudian-settings-tab-content--active' : ''}`,
    });
    tabContents.set('providers', providersContent);
    const providerTabBar = providersContent.createDiv({
      cls: 'claudian-settings-provider-tabs',
    });
    const providerContentHost = providersContent.createDiv({
      cls: 'claudian-settings-provider-content-host',
    });
    const providerButtons = new Map<ProviderId, HTMLButtonElement>();
    const providerContents = new Map<ProviderId, HTMLDivElement>();
    const renderedProviderIds = new Set<ProviderId>();

    const renderProviderTab = async (providerId: ProviderId): Promise<void> => {
      if (renderedProviderIds.has(providerId)) return;
      const providerContent = providerContents.get(providerId);
      if (!providerContent) return;
      renderedProviderIds.add(providerId);
      providerContent.empty();
      providerContent.createDiv({
        cls: 'claudian-settings-provider-loading',
        text: `Loading ${ProviderRegistry.getProviderDisplayName(providerId)} settings...`,
      });

      try {
        await ProviderWorkspaceRegistry.ensureInitialized(
          this.plugin.providerHost,
          providerId,
          'settings-tab',
        );
        if (renderGeneration !== this.renderGeneration) return;
        providerContent.empty();
        const renderer = ProviderWorkspaceRegistry.getSettingsTabRenderer(providerId);
        if (!renderer) {
          providerContent.createDiv({ text: 'Provider settings are unavailable.' });
          return;
        }
        const handle = renderer.render(providerContent, {
          plugin: this.plugin.providerHost,
          renderAgentSkillSettings: (target, _targetProviderId) => {
            new AgentSkillSettings(target, this.agentSkillCoordinator, this.app);
          },
          renderHiddenProviderCommandSetting: (
            target,
            targetProviderId,
            copy,
          ) => this.renderHiddenProviderCommandSetting(target, targetProviderId, copy),
          notifyProviderModelOptionsChanged: (changedProviderId) => {
            this.notifyProviderModelOptionsChanged(changedProviderId);
          },
          renderCustomContextLimits: (target, targetProviderId) => (
            this.renderCustomContextLimits(target, targetProviderId)
          ),
        });
        if (handle) this.providerSettingsRenders.set(providerId, handle);
        frameSettingsGroups(providerContent);
      } catch (error) {
        if (renderGeneration !== this.renderGeneration) return;
        renderedProviderIds.delete(providerId);
        providerContent.empty();
        const message = error instanceof Error ? error.message : 'Unknown error';
        providerContent.createDiv({
          cls: 'claudian-setting-validation claudian-setting-validation-error',
          text: `Could not load provider settings: ${message}`,
        });
      }
    };

    for (const id of tabIds) {
      const label = t(`settings.tabs.${id}`);
      const button = tabBar.createEl('button', {
        cls: `claudian-settings-tab${id === this.activeTab ? ' claudian-settings-tab--active' : ''}`,
        text: label,
      });
      button.addEventListener('click', () => {
        this.activeTab = id;
        for (const tabId of tabIds) {
          tabButtons.get(tabId)?.toggleClass('claudian-settings-tab--active', tabId === id);
          tabContents.get(tabId)?.toggleClass('claudian-settings-tab-content--active', tabId === id);
        }
        if (id === 'providers' && this.activeProviderTab) {
          void renderProviderTab(this.activeProviderTab);
        }
      });
      tabButtons.set(id, button);
    }

    for (const id of tabIds.filter(id => id !== 'providers')) {
      const content = containerEl.createDiv({
        cls: `claudian-settings-tab-content claudian-settings-${id}${id === this.activeTab ? ' claudian-settings-tab-content--active' : ''}`,
      });
      tabContents.set(id, content);
    }

    this.renderGeneralTab(tabContents.get('general')!);
    frameSettingsGroups(tabContents.get('general')!);

    for (const providerId of providerTabs) {
      const content = providerContentHost.createDiv({
        cls: `claudian-settings-provider-content${providerId === this.activeProviderTab ? ' claudian-settings-provider-content--active' : ''}`,
      });
      providerContents.set(providerId, content);
      const button = providerTabBar.createEl('button', {
        cls: `claudian-settings-provider-tab${providerId === this.activeProviderTab ? ' claudian-settings-provider-tab--active' : ''}`,
        text: ProviderRegistry.getProviderDisplayName(providerId),
      });
      button.addEventListener('click', () => {
        this.activeProviderTab = providerId;
        for (const candidate of providerTabs) {
          providerButtons.get(candidate)?.toggleClass(
            'claudian-settings-provider-tab--active',
            candidate === providerId,
          );
          providerContents.get(candidate)?.toggleClass(
            'claudian-settings-provider-content--active',
            candidate === providerId,
          );
        }
        void renderProviderTab(providerId);
      });
      providerButtons.set(providerId, button);
    }

    if (this.activeTab === 'providers' && this.activeProviderTab) {
      void renderProviderTab(this.activeProviderTab);
    }

    return () => {
      if (renderGeneration !== this.renderGeneration) return;
      settingItems?.classList.remove('claudian-settings-items');
      this.renderGeneration += 1;
      this.disposeProviderSettingsRenders();
      this.agentSkillCoordinator.resetSubscriptions();
      this.refreshTitleModelOptions = null;
    };
  }

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
          .onChange(async (value) => {
            const locale = value as Locale;
            if (!setLocale(locale)) {
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            await this.plugin.mutateSettings((settings) => {
              settings.locale = locale;
            });
            this.update();
          });
      });

    // --- Display ---

    new Setting(container).setName(t('settings.display')).setHeading();

    new Setting(container)
      .setName(t('settings.chatViewPlacement.name'))
      .setDesc(t('settings.chatViewPlacement.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('right-sidebar', t('settings.chatViewPlacement.rightSidebar'))
          .addOption('left-sidebar', t('settings.chatViewPlacement.leftSidebar'))
          .addOption('main-tab', t('settings.chatViewPlacement.mainTab'))
          .setValue(this.plugin.settings.chatViewPlacement)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.chatViewPlacement = value as ChatViewPlacement;
            });
          });
      });

    new Setting(container)
      .setName(t('settings.enableDualPane.name'))
      .setDesc(t('settings.enableDualPane.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDualPane ?? true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.enableDualPane = value;
            });
            this.update();
          })
      );

    if (this.plugin.settings.enableDualPane ?? true) {
      new Setting(container)
        .setName(t('settings.dualPaneSide.name'))
        .setDesc(t('settings.dualPaneSide.desc'))
        .addDropdown((dropdown) => {
          dropdown
            .addOption('left', t('settings.dualPaneSide.left'))
            .addOption('right', t('settings.dualPaneSide.right'))
            .setValue(this.plugin.settings.dualPaneSide ?? 'right')
            .onChange(async (value) => {
              await this.plugin.mutateSettings((settings) => {
                settings.dualPaneSide = value as DualPaneSide;
              });
              });
        });

    }

    new Setting(container)
      .setName(t('settings.restoreTabsOnStartup.name'))
      .setDesc(t('settings.restoreTabsOnStartup.desc'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.restoreTabsOnStartup)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.restoreTabsOnStartup = value;
            });
          });
      });

    new Setting(container)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.enableAutoScroll = value;
            });
          })
      );

    new Setting(container)
      .setName(t('settings.showMessageTimestamps.name'))
      .setDesc(t('settings.showMessageTimestamps.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showMessageTimestamps === true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.showMessageTimestamps = value;
            });
          })
      );

    new Setting(container)
      .setName(t('settings.deferMathRenderingDuringStreaming.name'))
      .setDesc(t('settings.deferMathRenderingDuringStreaming.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deferMathRenderingDuringStreaming ?? true)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.deferMathRenderingDuringStreaming = value;
            });
          })
      );

    new Setting(container)
      .setName(t('settings.expandFileEditsByDefault.name'))
      .setDesc(t('settings.expandFileEditsByDefault.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.expandFileEditsByDefault ?? false)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.expandFileEditsByDefault = value;
            });
          })
      );

    // --- Conversations ---

    new Setting(container).setName(t('settings.conversations')).setHeading();

    new Setting(container)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.enableAutoTitleGeneration = value;
            });
            this.update();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(container)
        .setName(t('settings.titleLanguage.name'))
        .setDesc(t('settings.titleLanguage.desc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('', t('settings.titleLanguage.followInterface'));
          for (const locale of getAvailableLocales()) {
            dropdown.addOption(locale, getLocaleDisplayName(locale));
          }
          dropdown
            .setValue(this.plugin.settings.titleGenerationLocale || '')
            .onChange(async (value) => {
              await this.plugin.mutateSettings((settings) => {
                settings.titleGenerationLocale = value;
              });
            });
        });

      new Setting(container)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute('aria-label', t('settings.titleModel.name'));
          const warning = dropdown.selectEl.parentElement!.createDiv();
          warning.className = 'claudian-setting-validation claudian-setting-validation-warning';
          warning.setAttribute('role', 'status');
          warning.setAttribute('aria-live', 'polite');
          warning.textContent = t('settings.titleModel.unavailableWarning');
          dropdown.selectEl.insertAdjacentElement('afterend', warning);
          const refreshOptions = (): void => {
            dropdown.selectEl.replaceChildren();
            dropdown.addOption('', t('settings.titleModel.select'));
            dropdown.selectEl.options[0].disabled = true;
            dropdown.selectEl.required = true;

            const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
            warning.hidden = ProviderRegistry.resolveTitleGenerationSelection(settingsBag) !== null;
            for (const model of ProviderRegistry.getTitleGenerationModelOptions(settingsBag)) {
              dropdown.addOption(model.value, model.label);
            }
            const selected = this.plugin.settings.titleGenerationModel;
            if (selected && !Array.from(dropdown.selectEl.options).some(option => option.value === selected)) {
              dropdown.addOption(selected, `Unavailable: ${selected}`);
              dropdown.selectEl.options[dropdown.selectEl.options.length - 1].disabled = true;
            }
            dropdown.setValue(this.plugin.settings.titleGenerationModel || '');
          };

          this.refreshTitleModelOptions = refreshOptions;
          refreshOptions();
          dropdown.onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              ProviderSettingsCoordinator.applyTitleGenerationModelSelection(settings, value);
            });
            refreshOptions();
          });
        });
    }

    // --- Content ---

    new Setting(container).setName(t('settings.content')).setHeading();

    new Setting(container)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.userName = value;
            });
          });
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .setClass('claudian-settings-textarea')
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.systemPrompt = value;
            });
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .setClass('claudian-settings-textarea')
      .addTextArea((text) => {
        text
          .setPlaceholder('System\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.excludedTags = value
                .split(/\r?\n/)
                .map((entry) => entry.trim().replace(/^#/, ''))
                .filter((entry) => entry.length > 0);
            });
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(container)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('Attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.mediaFolder = value.trim();
            });
          });
        text.inputEl.addClass('claudian-settings-media-input');
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    // --- Input ---

    new Setting(container).setName(t('settings.input')).setHeading();

    new Setting(container)
      .setName(t('settings.requireCommandOrControlEnterToSend.name'))
      .setDesc(t('settings.requireCommandOrControlEnterToSend.desc'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.requireCommandOrControlEnterToSend ?? false)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.requireCommandOrControlEnterToSend = value;
            });
          });
      });

    new Setting(container)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .setClass('claudian-settings-textarea')
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

          await this.plugin.mutateSettings((settings) => {
            settings.keyboardNavigation.scrollUpKey = result.settings!.scrollUp;
            settings.keyboardNavigation.scrollDownKey = result.settings!.scrollDown;
            settings.keyboardNavigation.focusInputKey = result.settings!.focusInput;
          });
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
          .setPlaceholder('Map w scrollup\nmap s scrolldown\nmap i focusinput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', () => {
          void commitValue(true);
        });
      });

    // --- Hotkeys ---

    new Setting(container).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = container.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: this.plugin.providerHost,
      scope: 'shared',
      heading: t('settings.environment'),
      name: 'Shared environment',
      desc: 'Provider-neutral runtime variables shared across all providers. Use this for PATH, proxy, cert, and temp variables.',
      placeholder: 'PATH=/opt/homebrew/bin:/usr/local/bin\nHTTPS_PROXY=http://proxy.example.com:8080\nSSL_CERT_FILE=/path/to/cert.pem',
    });

    // --- Advanced ---

    new Setting(container).setName(t('common.advanced')).setHeading();

    new Setting(container)
      .setName(t('settings.maxWarmAgentProcesses.name'))
      .setDesc(t('settings.maxWarmAgentProcesses.desc'))
      .addSlider((slider) => {
        slider
          .setLimits(MIN_WARM_AGENT_PROCESSES, MAX_WARM_AGENT_PROCESSES, 1)
          .setValue(this.plugin.settings.maxWarmAgentProcesses ?? 5)
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.maxWarmAgentProcesses = value;
            });

          });
      });

  }

  private disposeProviderSettingsRenders(): void {
    for (const handle of this.providerSettingsRenders.values()) handle.dispose();
    this.providerSettingsRenders.clear();
  }

  refreshModelOptions(): void {
    for (const handle of this.providerSettingsRenders.values()) handle.refresh();
    this.refreshTitleModelOptions?.();
  }

  private notifyProviderModelOptionsChanged(providerId: ProviderId): void {
    this.plugin.notifyProviderChatOptionsChanged(providerId);
    this.refreshTitleModelOptions?.();
  }

  private renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void {
    new Setting(container)
      .setName(copy.name)
      .setDesc(copy.desc)
      .setClass('claudian-settings-textarea')
      .addTextArea((text) => {
        text
          .setPlaceholder(copy.placeholder)
          .setValue(getHiddenProviderCommands(this.plugin.settings, providerId).join('\n'))
          .onChange(async (value) => {
            await this.plugin.mutateSettings((settings) => {
              settings.hiddenProviderCommands = {
                ...settings.hiddenProviderCommands,
                [providerId]: normalizeHiddenCommandList(value.split(/\r?\n/)),
              };
            });
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });
  }

  private renderCustomContextLimits(container: HTMLElement, providerId: ProviderId): void {
    container.empty();

    const modelAliases = ProviderRegistry.getChatUIConfig(providerId).customModelAliases;
    const uniqueModelIds = new Set<string>();
    const envVars = parseEnvironmentVariables(
      this.plugin.getActiveEnvironmentVariables(providerId),
    );
    for (const modelId of ProviderRegistry.getChatUIConfig(providerId).getCustomModelIds(envVars)) {
      uniqueModelIds.add(modelId);
    }

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({
      text: t('settings.customModelOverrides.name'),
      cls: 'claudian-context-limits-label',
    });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customModelOverrides.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];
      const currentAlias = (modelAliases?.get(this.plugin.settings) ?? {})[modelId] ?? '';

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });
      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });
      const aliasInputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: t('settings.customModelAliases.placeholder'),
        cls: 'claudian-context-alias-input',
        value: currentAlias,
      });
      aliasInputEl.setAttribute('aria-label', `Alias for ${modelId}`);
      aliasInputEl.title = 'Custom label shown in the model selector. Leave empty to use the default.';

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });
      inputEl.setAttribute('aria-label', `Context window for ${modelId}`);

      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation claudian-hidden' });

      const saveAlias = async (): Promise<void> => {
        const existing = (modelAliases?.get(this.plugin.settings) ?? {})[modelId] ?? '';
        const trimmed = aliasInputEl.value.trim();
        if (trimmed === existing) {
          aliasInputEl.value = existing;
          return;
        }

        await this.plugin.mutateSettings((settings) => {
          const aliases = (modelAliases?.get(settings) ?? {});
          if (trimmed) {
            aliases[modelId] = trimmed;
          } else {
            delete aliases[modelId];
          }
          modelAliases?.update(settings, aliases);
        });
        this.notifyProviderModelOptionsChanged(providerId);
      };

      const saveContextLimit = async (): Promise<void> => {
        const trimmed = inputEl.value.trim();

        if (!trimmed) {
          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.toggleClass('claudian-hidden', false);
            inputEl.classList.add('claudian-input-error');
            return;
          }

          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        }
        await this.plugin.mutateSettings((settings) => {
          settings.customContextLimits ??= {};
          if (!trimmed) {
            delete settings.customContextLimits[modelId];
          } else {
            settings.customContextLimits[modelId] = parseContextLimit(trimmed)!;
          }
        });
      };

      inputEl.addEventListener('input', () => {
        void saveContextLimit();
      });
      aliasInputEl.addEventListener('blur', () => {
        void saveAlias();
      });
      aliasInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          aliasInputEl.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          aliasInputEl.value = (modelAliases?.get(this.plugin.settings) ?? {})[modelId] ?? '';
          aliasInputEl.blur();
        }
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    try {
      await this.plugin.providerHost.runProviderExecutionTransition(
        ProviderRegistry.getRegisteredProviderIds(),
        async () => undefined,
      );
    } catch {
      // Changes will apply when the next provider execution starts.
    }
  }
}
