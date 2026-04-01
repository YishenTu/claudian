import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getCodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { CodexSkillSettings } from './CodexSkillSettings';
import { CodexSubagentSettings } from './CodexSubagentSettings';

export const codexSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const codexWorkspace = getCodexWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const codexSettings = getCodexProviderSettings(settingsBag);
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

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:codex',
      heading: t('settings.environment'),
      name: 'Codex environment',
      desc: 'Codex-owned runtime variables only. Use this for OPENAI_* and CODEX_* settings.',
      placeholder: 'OPENAI_API_KEY=your-key\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=gpt-5.4\nCODEX_SANDBOX=workspace-write',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'codex'),
    });

    const currentValue = codexSettings.cliPathsByHost[hostnameKey] || '';

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
          const nextCliPathsByHost = { ...codexSettings.cliPathsByHost };
          if (trimmed) {
            nextCliPathsByHost[hostnameKey] = trimmed;
          } else {
            delete nextCliPathsByHost[hostnameKey];
          }
          updateCodexProviderSettings(settingsBag, { cliPathsByHost: nextCliPathsByHost });
          await context.plugin.saveSettings();
          const view = context.plugin.getView();
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
  },
};
