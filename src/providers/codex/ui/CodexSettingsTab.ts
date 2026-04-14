import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getCodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { isWindowsStyleCliReference } from '../runtime/CodexBinaryLocator';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
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

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable Codex provider')
      .setDesc('When enabled, Codex models appear in the model selector for new conversations. Existing Codex sessions are preserved.')
      .addToggle((toggle) =>
        toggle
          .setValue(codexSettings.enabled)
          .onChange(async (value) => {
            updateCodexProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    if (isWindowsHost) {
      new Setting(container)
        .setName('Installation method')
        .setDesc('How Claudian should launch Codex on Windows. Native Windows uses a Windows executable path. WSL launches the Linux CLI inside a selected distro.')
        .addDropdown((dropdown) => {
          dropdown
            .addOption('native-windows', 'Native Windows')
            .addOption('wsl', 'WSL')
            .setValue(installationMethod)
            .onChange(async (value) => {
              installationMethod = value === 'wsl' ? 'wsl' : 'native-windows';
              updateCodexProviderSettings(settingsBag, { installationMethod });
              refreshInstallationMethodUI();
              await context.plugin.saveSettings();
            });
        });
    }

    const getCliPathCopy = (): { desc: string; placeholder: string } => {
      if (!isWindowsHost) {
        return {
          desc: 'Custom path to the local Codex CLI. Leave empty for auto-detection from PATH.',
          placeholder: '/usr/local/bin/codex',
        };
      }

      if (installationMethod === 'wsl') {
        return {
          desc: 'Linux-side Codex command or absolute path to run inside WSL. Leave empty for PATH lookup inside the selected distro.',
          placeholder: 'codex',
        };
      }

      return {
        desc: 'Custom path to the local Codex CLI. Leave empty for auto-detection from PATH. Use the native Windows executable path, usually `codex.exe`.',
        placeholder: 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe',
      };
    };

    const shouldValidateCliPathAsFile = (): boolean => !isWindowsHost || installationMethod !== 'wsl';

    const cliPathSetting = new Setting(container)
      .setName(`Codex CLI path (${hostnameKey})`)
      .setDesc(getCliPathCopy().desc);

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      if (!shouldValidateCliPathAsFile()) {
        if (isWindowsStyleCliReference(trimmed)) {
          return 'WSL mode expects a Linux command or Linux absolute path, not a Windows executable path.';
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
        validationEl.style.display = 'block';
        if (inputEl) {
          inputEl.style.borderColor = 'var(--text-error)';
        }
        return false;
      }

      validationEl.style.display = 'none';
      if (inputEl) {
        inputEl.style.borderColor = '';
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
        wslDistroSettingEl.style.display = installationMethod === 'wsl' ? '' : 'none';
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

      updateCodexProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      await context.plugin.saveSettings();
      const view = context.plugin.getView();
      await view?.getTabManager()?.broadcastToAllTabs(
        (service) => Promise.resolve(service.cleanup())
      );
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
      text.inputEl.style.width = '100%';
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    if (isWindowsHost) {
      const wslDistroSetting = new Setting(container)
        .setName('WSL distro override')
        .setDesc('Optional advanced override. Leave empty to infer the distro from a \\\\wsl$ workspace path when possible, otherwise use the default WSL distro.');

      wslDistroSettingEl = wslDistroSetting.settingEl;
      wslDistroSetting.addText((text) => {
        text
          .setPlaceholder('Ubuntu')
          .setValue(codexSettings.wslDistroOverride)
          .onChange(async (value) => {
            updateCodexProviderSettings(settingsBag, { wslDistroOverride: value });
            await context.plugin.saveSettings();
          });

        text.inputEl.addClass('claudian-settings-cli-path-input');
        text.inputEl.style.width = '100%';
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
          .addOption('workspace-write', 'workspace-write')
          .addOption('read-only', 'read-only')
          .setValue(codexSettings.safeMode)
          .onChange(async (value) => {
            updateCodexProviderSettings(
              settingsBag,
              { safeMode: value as 'workspace-write' | 'read-only' },
            );
            await context.plugin.saveSettings();
          });
      });

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    const SUMMARY_OPTIONS: { value: string; label: string }[] = [
      { value: 'auto', label: 'Auto' },
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
        dropdown.setValue(codexSettings.reasoningSummary);
        dropdown.onChange(async (value) => {
          updateCodexProviderSettings(
            settingsBag,
            { reasoningSummary: value as 'auto' | 'concise' | 'detailed' | 'none' },
          );
          await context.plugin.saveSettings();
        });
      });

    // --- Skills ---

    const codexCatalog = codexWorkspace.commandCatalog;
    if (codexCatalog) {
      new Setting(container).setName('Codex Skills').setHeading();

      const skillsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
      skillsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: 'Manage vault-level Codex skills stored in .codex/skills/ or .agents/skills/. Home-level skills are excluded here.',
      });

      const skillsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
      new CodexSkillSettings(skillsContainer, codexCatalog, context.plugin.app);
    }

    context.renderHiddenProviderCommandSetting(container, 'codex', {
      name: 'Hidden Skills',
      desc: 'Hide specific Codex skills from the dropdown. Enter skill names without the leading $, one per line.',
      placeholder: 'analyze\nexplain\nfix',
    });

    // --- Subagents ---

    new Setting(container).setName('Codex Subagents').setHeading();

    const subagentDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    subagentDesc.createEl('p', {
      cls: 'setting-item-description',
      text: 'Manage vault-level Codex subagents stored in .codex/agents/. Each TOML file defines one custom agent.',
    });

    const subagentContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new CodexSubagentSettings(subagentContainer, codexWorkspace.subagentStorage, context.plugin.app, () => {
      void codexWorkspace.refreshAgentMentions?.();
    });

    // --- MCP Servers ---

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

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:codex',
      heading: t('settings.environment'),
      name: 'Codex environment',
      desc: 'Codex-owned runtime variables only. Use this for OPENAI_* and CODEX_* settings. If Codex auto-detection needs help, add its install directory to shared PATH instead of this provider section.',
      placeholder: 'OPENAI_API_KEY=your-key\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=gpt-5.4\nCODEX_SANDBOX=workspace-write',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'codex'),
    });
  },
};
