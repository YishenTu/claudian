import * as fs from 'fs';
import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderNativeMcpSettingsSection } from '../../../shared/settings/NativeMcpSettingsSection';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCliPath, stripSurroundingQuotes } from '../../../utils/path';
import { getCodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { getCodexModelOptions } from '../modelOptions';
import { getDefaultCodexModel } from '../models';
import { isWindowsStyleCliReference } from '../runtime/CodexBinaryLocator';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { renderCodexModelPicker } from './CodexModelPicker';
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

    renderProviderEnablementSetting({
      container,
      description: t('settings.providerEnablement.desc', { provider: 'Codex' }),
      getValue: () => getCodexProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'Codex' }),
      onChange: async (value) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          'codex',
          value,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(['codex'], async () => {
          await context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              'codex',
              value,
            );
          });
        });
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged('codex');
      },
    });

    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => getCodexModelOptions(settingsBag).length > 0,
      getIsEnabled: () => getCodexProviderSettings(settingsBag).enabled,
      providerId: 'codex',
      providerName: 'Codex',
    });

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
              await context.plugin.applyProviderRuntimeSettings(
                ['codex'],
                (settings) => {
                  updateCodexProviderSettings(settings, { installationMethod });
                },
                () => codexWorkspace.cliResolver.reset(),
              );
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

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      if (!shouldValidateCliPathAsFile()) {
        if (isWindowsStyleCliReference(stripSurroundingQuotes(trimmed))) {
          return t('settings.codex.cliPath.validation.wslWindowsPath');
        }
        return null;
      }

      const expandedPath = normalizeConfiguredCliPath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    let wslDistroSettingEl: HTMLElement | null = null;
    let wslDistroInputEl: HTMLInputElement | null = null;

    const cliPathControl = renderHostnameCliPathSetting({
      container,
      description: getCliPathCopy().desc,
      getValue: () => getCodexProviderSettings(settingsBag).cliPathsByHost[hostnameKey] || '',
      name: t('settings.codex.cliPath.name'),
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getCodexProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }

        await context.plugin.applyProviderRuntimeSettings(
          ['codex'],
          (settings) => {
            updateCodexProviderSettings(settings, { cliPathsByHost });
          },
          () => codexWorkspace.cliResolver.reset(),
        );
      },
      placeholder: getCliPathCopy().placeholder,
      validate: validatePath,
    });

    const refreshInstallationMethodUI = (): void => {
      const cliCopy = getCliPathCopy();
      cliPathControl.setDescription(cliCopy.desc);
      cliPathControl.setPlaceholder(cliCopy.placeholder);
      cliPathControl.revalidate();
      if (wslDistroSettingEl) {
        wslDistroSettingEl.toggleClass('claudian-hidden', installationMethod !== 'wsl');
      }
      if (wslDistroInputEl) {
        wslDistroInputEl.disabled = installationMethod !== 'wsl';
      }
    };

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
            await context.plugin.applyProviderRuntimeSettings(
              ['codex'],
              (settings) => {
                updateCodexProviderSettings(settings, { wslDistroOverride: value });
              },
              () => codexWorkspace.cliResolver.reset(),
            );
          });

        text.inputEl.addClass('claudian-settings-cli-path-input');
        text.inputEl.disabled = installationMethod !== 'wsl';
        wslDistroInputEl = text.inputEl;
      });
    }

    refreshInstallationMethodUI();

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    const modelPicker = renderCodexModelPicker(container, modelWarning.context, codexWorkspace);

    new Setting(container)
      .setName(t('settings.codex.ultraEffort.name'))
      .setDesc(t('settings.codex.ultraEffort.desc'))
      .addToggle(toggle => toggle
        .setValue(codexSettings.enableUltraEffort)
        .onChange(async (value) => {
          await context.plugin.mutateSettings((settings) => {
            updateCodexProviderSettings(settings, { enableUltraEffort: value });
            ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
          });
          modelPicker.refresh();
          context.notifyProviderModelOptionsChanged('codex');
        }));

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

    // --- Skills ---

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, 'codex');

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

    renderNativeMcpSettingsSection(container, {
      descriptionAfterCommand: t('settings.codex.mcp.descAfterCommand'),
      descriptionBeforeCommand: t('settings.codex.mcp.descBeforeCommand'),
      documentationLabel: t('settings.codex.mcp.learnMore'),
      documentationUrl: 'https://developers.openai.com/codex/mcp',
      heading: t('settings.mcpServers.name'),
      setupCommand: 'codex mcp',
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
