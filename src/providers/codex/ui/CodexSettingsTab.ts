import * as fs from 'fs';
import { Notice, Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getCodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { getDefaultCodexModel } from '../models';
import { isWindowsStyleCliReference } from '../runtime/CodexBinaryLocator';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { renderCodexModelPicker } from './CodexModelPicker';
import { CodexSkillSettings } from './CodexSkillSettings';
import { CodexSubagentSettings } from './CodexSubagentSettings';

export const codexSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const codexWorkspace = getCodexWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const codexSettings = getCodexProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const isWindowsHost = process.platform === 'win32';
    let installationMethod = codexSettings.installationMethod;
    const environmentModelPlaceholder = getDefaultCodexModel(codexSettings.discoveredModels)?.model
      ?? 'model-id';

    const refreshCodexModelCatalog = async (): Promise<void> => {
      const result = await codexWorkspace.refreshModelCatalog?.();
      if (result?.diagnostics) {
        new Notice(`Codex model discovery failed: ${result.diagnostics}`);
      }
    };

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName(t('settings.codex.enableProvider.name'))
      .setDesc(t('settings.codex.enableProvider.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(codexSettings.enabled)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(settings, { enabled: value });
            });
            if (value) {
              await refreshCodexModelCatalog();
            }
            context.refreshModelSelectors();
          })
      );

    if (isWindowsHost) {
      new Setting(container)
        .setName(t('settings.codex.installationMethod.name'))
        .setDesc(t('settings.codex.installationMethod.desc'))
        .addDropdown((dropdown) => {
          dropdown
            .addOption('native-windows', t('settings.codex.installationMethod.nativeWindows'))
            .addOption('wsl', t('settings.codex.installationMethod.wsl'))
            .setValue(installationMethod)
            .onChange(async (value) => {
              installationMethod = value === 'wsl' ? 'wsl' : 'native-windows';
              await context.plugin.mutateSettings((settings) => {
                updateCodexProviderSettings(settings, { installationMethod });
              });
              refreshInstallationMethodUI();
              await refreshCodexModelCatalog();
            });
        });
    }

    const getCliPathCopy = (): { desc: string; placeholder: string } => {
      if (!isWindowsHost) {
        return {
          desc: t('settings.codex.cliPath.descUnix'),
          placeholder: '/usr/local/bin/codex',
        };
      }

      if (installationMethod === 'wsl') {
        return {
          desc: t('settings.codex.cliPath.descWsl'),
          placeholder: 'codex',
        };
      }

      return {
        desc: t('settings.codex.cliPath.descWindows'),
        placeholder: 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe',
      };
    };

    const shouldValidateCliPathAsFile = (): boolean => !isWindowsHost || installationMethod !== 'wsl';

    const cliPathSetting = new Setting(container)
      .setName(t('settings.codex.cliPath.name'))
      .setDesc(getCliPathCopy().desc);

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      if (!shouldValidateCliPathAsFile()) {
        if (isWindowsStyleCliReference(trimmed)) {
          return t('settings.codex.cliPath.validation.wslWindowsPath');
        }
        return null;
      }

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

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        if (inputEl) {
          inputEl.toggleClass('claudian-input-error', true);
        }
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      if (inputEl) {
        inputEl.toggleClass('claudian-input-error', false);
      }
      return true;
    };

    const cliPathsByHost = { ...codexSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;
    let wslDistroSettingEl: HTMLElement | null = null;
    let wslDistroInputEl: HTMLInputElement | null = null;

    const refreshInstallationMethodUI = (): void => {
      const cliCopy = getCliPathCopy();
      cliPathSetting.setDesc(cliCopy.desc);
      if (cliPathInputEl) {
        cliPathInputEl.placeholder = cliCopy.placeholder;
        updateCliPathValidation(cliPathInputEl.value, cliPathInputEl);
      }
      if (wslDistroSettingEl) {
        wslDistroSettingEl.toggleClass('claudian-hidden', installationMethod !== 'wsl');
      }
      if (wslDistroInputEl) {
        wslDistroInputEl.disabled = installationMethod !== 'wsl';
      }
    };

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateCodexProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
      });
      await context.plugin.recycleProviderRuntimes?.('codex');
      return true;
    };

    const currentValue = codexSettings.cliPathsByHost[hostnameKey] || '';

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(getCliPathCopy().placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    if (isWindowsHost) {
      const wslDistroSetting = new Setting(container)
        .setName(t('settings.codex.wslDistroOverride.name'))
        .setDesc(t('settings.codex.wslDistroOverride.desc'));

      wslDistroSettingEl = wslDistroSetting.settingEl;
      wslDistroSetting.addText((text) => {
        text
          .setPlaceholder('Ubuntu')
          .setValue(codexSettings.wslDistroOverride)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(settings, { wslDistroOverride: value });
            });
          });

        text.inputEl.addClass('claudian-settings-cli-path-input');
        text.inputEl.disabled = installationMethod !== 'wsl';
        wslDistroInputEl = text.inputEl;
      });
    }

    refreshInstallationMethodUI();

    // --- Safety ---

    new Setting(container).setName(t('settings.safety')).setHeading();

    new Setting(container)
      .setName(t('settings.codexSafeMode.name'))
      .setDesc(t('settings.codexSafeMode.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('workspace-write', t('settings.codex.safeMode.workspaceWrite'))
          .addOption('read-only', t('settings.codex.safeMode.readOnly'))
          .setValue(codexSettings.safeMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateCodexProviderSettings(
                settings,
                { safeMode: value as 'workspace-write' | 'read-only' },
              );
            });
          });
      });

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    renderCodexModelPicker(container, context, codexWorkspace);

    const SUMMARY_OPTIONS: { value: string; label: string }[] = [
      { value: 'auto', label: t('settings.codex.reasoningSummary.auto') },
      { value: 'concise', label: t('settings.codex.reasoningSummary.concise') },
      { value: 'detailed', label: t('settings.codex.reasoningSummary.detailed') },
      { value: 'none', label: t('settings.codex.reasoningSummary.off') },
    ];

    new Setting(container)
      .setName(t('settings.codex.reasoningSummary.name'))
      .setDesc(t('settings.codex.reasoningSummary.desc'))
      .addDropdown((dropdown) => {
        for (const opt of SUMMARY_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown.setValue(codexSettings.reasoningSummary);
        dropdown.onChange(async (value) => {
          await context.plugin.mutateSettings((settings) => {
            updateCodexProviderSettings(
              settings,
              { reasoningSummary: value as 'auto' | 'concise' | 'detailed' | 'none' },
            );
          });
        });
      });

    // --- Skills ---

    const codexCatalog = codexWorkspace.commandCatalog;
    if (codexCatalog) {
      new Setting(container).setName(t('settings.codex.skills.name')).setHeading();

      const skillsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      skillsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: t('settings.codex.skills.desc'),
      });

      const skillsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new CodexSkillSettings(skillsContainer, codexCatalog, context.plugin.app);
    }

    context.renderHiddenProviderCommandSetting(container, 'codex', {
      name: t('settings.codex.skills.hiddenName'),
      desc: t('settings.codex.skills.hiddenDesc'),
      placeholder: t('settings.codex.skills.hiddenPlaceholder'),
    });

    // --- Subagents ---

    new Setting(container).setName(t('settings.codex.subagents.name')).setHeading();

    const subagentDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    subagentDesc.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.codex.subagents.desc'),
    });

    const subagentContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new CodexSubagentSettings(subagentContainer, codexWorkspace.subagentStorage, context.plugin.app, () => {
      void codexWorkspace.refreshAgentMentions?.();
    });

    // --- MCP Servers ---

    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();
    const mcpNotice = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    const mcpDesc = mcpNotice.createEl('p', { cls: 'setting-item-description' });
    mcpDesc.appendText(t('settings.codex.mcp.descBeforeCommand'));
    mcpDesc.createEl('code').appendText('codex mcp');
    mcpDesc.appendText(t('settings.codex.mcp.descAfterCommand'));
    mcpDesc.createEl('a', {
      text: t('settings.codex.mcp.learnMore'),
      href: 'https://developers.openai.com/codex/mcp',
    });

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:codex',
      heading: t('settings.environment'),
      name: t('settings.codex.environment.name'),
      desc: t('settings.codex.environment.desc'),
      placeholder: `OPENAI_API_KEY=your-key\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=${environmentModelPlaceholder}\nCODEX_SANDBOX=workspace-write`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'codex'),
    });
  },
};
