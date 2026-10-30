import * as fs from 'fs';
import { Setting } from 'obsidian';

import { isWindowsStyleCLIReference, normalizeConfiguredCLIPath, stripSurroundingQuotes } from '@/core/process/cliPath';
import { type InstallationSettings, normalizeInstallationMethod } from '@/core/providers/settings/InstallationSettings';
import { t } from '@/i18n/i18n';

interface ExecutionTargetSettingsOptions {
  container: HTMLElement;
  providerName: string;
  getValue: () => InstallationSettings;
  onChange: (updates: Partial<InstallationSettings>) => Promise<void>;
  onRefresh: () => void;
}

export function renderExecutionTargetSettings(options: ExecutionTargetSettingsOptions): void {
  if (process.platform !== 'win32') return;
  const { container, getValue } = options;
  let distroInput: HTMLInputElement;
  const refresh = () => {
    const isWSL = getValue().installationMethod === 'wsl';
    distroSetting.settingEl.toggleClass('claudian-hidden', !isWSL);
    distroInput.disabled = !isWSL;
  };
  new Setting(container)
    .setName(t('settings.executionTarget.installationMethod.name'))
    .setDesc(t('settings.executionTarget.installationMethod.desc', { provider: options.providerName }))
    .addDropdown(dropdown => {
      dropdown.selectEl.setAttribute('aria-label', t('settings.executionTarget.installationMethod.name'));
      dropdown
        .addOption('native-windows', t('settings.executionTarget.installationMethod.nativeWindows'))
        .addOption('wsl', t('settings.executionTarget.installationMethod.wsl'))
        .setValue(getValue().installationMethod)
        .onChange(async value => {
          try {
            await options.onChange({ installationMethod: normalizeInstallationMethod(value) });
          } finally {
            dropdown.setValue(getValue().installationMethod);
            refresh();
            options.onRefresh();
          }
        });
    });
  const distroSetting = new Setting(container)
    .setName(t('settings.executionTarget.wslDistroOverride.name'))
    .setDesc(t('settings.executionTarget.wslDistroOverride.desc'));
  distroSetting.addText(text => {
    distroInput = text.inputEl;
    distroInput.setAttribute('aria-label', t('settings.executionTarget.wslDistroOverride.name'));
    distroInput.addClass('claudian-settings-cli-path-input');
    text.setPlaceholder('Ubuntu').setValue(getValue().wslDistroOverride).onChange(async value => {
      await options.onChange({ wslDistroOverride: value });
      options.onRefresh();
    });
  });
  refresh();
}

export function validateExecutionTargetCLIPath(value: string, settings: InstallationSettings): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (process.platform === 'win32' && settings.installationMethod === 'wsl') {
    return isWindowsStyleCLIReference(stripSurroundingQuotes(trimmed))
      ? t('settings.executionTarget.wslWindowsPath') : null;
  }
  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!fs.existsSync(expandedPath)) return t('settings.cliPath.validation.notExist');
  if (!fs.statSync(expandedPath).isFile()) return t('settings.cliPath.validation.isDirectory');
  return null;
}
