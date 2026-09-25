import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderIconSvg } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { createProviderIconSvg } from '@/shared/icons';

import {
  type HostnameCLIPathSettingControl,
  type HostnameCLIPathSettingOptions,
  renderHostnameCLIPathSetting,
} from './HostnameCLIPathSetting';
import { type ProviderEnablementSettingOptions, renderProviderEnablementSetting } from './ProviderEnablementSetting';

export interface CLIInstallationSettingOptions extends Omit<HostnameCLIPathSettingOptions, 'description'> {
  enablement?: Omit<ProviderEnablementSettingOptions, 'container' | 'description'>;
  cliName: string;
  icon?: ProviderIconSvg;
  inspect: () => Promise<CLIInstallation>;
}

export interface CLIInstallationSettingControl extends HostnameCLIPathSettingControl {
  refresh: () => Promise<void>;
}

const installationRefreshers = new WeakMap<HTMLElement, () => Promise<void>>();

export function refreshCLIInstallations(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.claudian-cli-installation')) {
    void installationRefreshers.get(card)?.();
  }
}

let nextId = 0;

export function renderCLIInstallationSetting(
  options: CLIInstallationSettingOptions,
): CLIInstallationSettingControl {
  let draft = options.getValue();
  let disabled = options.disabled ?? false;
  let saving = false;
  let generation = 0;
  options.container.classList.add('claudian-cli-installation-container');
  const card = options.container.createDiv({ cls: 'claudian-cli-installation' });
  const heading = card.createDiv({ cls: 'claudian-cli-installation-heading' });
  const header = heading.createEl('button', {
    cls: 'claudian-cli-installation-header',
    attr: { type: 'button', 'aria-label': t('settings.cliInstallation.disclosure', { name: options.cliName }), 'aria-expanded': 'false' },
  });
  const icon = header.createSpan({ cls: 'claudian-cli-installation-icon', attr: { 'aria-hidden': 'true' } });
  if (options.icon) createProviderIconSvg(options.icon, { parent: icon });
  const dot = icon.createSpan({ cls: 'claudian-cli-installation-dot' });
  const summary = header.createSpan({ cls: 'claudian-cli-installation-summary' });
  const title = summary.createSpan({ cls: 'claudian-cli-installation-title' });
  title.createSpan({ text: options.cliName });
  const version = title.createSpan({ cls: 'claudian-cli-installation-version' });
  const status = summary.createSpan({ cls: 'claudian-cli-installation-status', attr: { role: 'status' } });
  const chevron = header.createSpan({ cls: 'claudian-cli-installation-chevron', text: '›', attr: { 'aria-hidden': 'true' } });
  if (options.enablement) {
    const enablement = heading.createDiv({ cls: 'claudian-cli-installation-enablement' });
    renderProviderEnablementSetting({ ...options.enablement, container: enablement, description: '' });
  }
  const body = card.createDiv({ cls: 'claudian-cli-installation-body' });
  body.id = `claudian-cli-installation-${++nextId}`;
  summary.id = `${body.id}-summary`;
  status.id = `${body.id}-status`;
  header.setAttribute('aria-describedby', `${summary.id} ${status.id}`);
  body.hidden = true;
  header.setAttribute('aria-controls', body.id);
  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    header.setAttribute('aria-expanded', String(!body.hidden));
    chevron.textContent = body.hidden ? '›' : '⌄';
  });

  const location = body.createDiv({ cls: 'claudian-cli-installation-location' });
  const path = location.createSpan({ cls: 'claudian-cli-installation-path' });
  const control = renderHostnameCLIPathSetting({
    ...options,
    container: body,
    description: t('settings.cliInstallation.description'),
    getValue: () => draft,
    onChange: (value) => { draft = value; },
  });
  control.text.inputEl.setAttribute('aria-describedby', `${body.id}-error`);
  control.validationEl.id = `${body.id}-error`;
  control.validationEl.setAttribute('role', 'alert');

  const refresh = async (): Promise<void> => {
    const current = ++generation;
    dot.dataset.state = 'checking';
    version.textContent = '';
    path.textContent = t('settings.cliInstallation.checking');
    status.textContent = t('settings.cliInstallation.checking');
    try {
      const installation = await options.inspect();
      if (current !== generation) return;
      dot.dataset.state = installation.path ? 'found' : 'missing';
      version.textContent = installation.path
        ? (installation.version ? `v${installation.version.replace(/^v/, '')}` : t('settings.cliInstallation.versionUnavailable'))
        : '';
      path.textContent = installation.path ?? t('settings.cliInstallation.notFound');
      path.title = installation.path ?? '';
      status.textContent = t(installation.path
        ? (installation.source === 'custom' ? 'settings.cliInstallation.custom' : 'settings.cliInstallation.auto')
        : 'settings.cliInstallation.notFound');
    } catch {
      if (current !== generation) return;
      dot.dataset.state = 'missing';
      path.textContent = t('settings.cliInstallation.checkFailed');
      status.textContent = path.textContent;
    }
  };
  const setDisabled = (value: boolean): void => {
    disabled = value;
    control.setDisabled(disabled || saving);
  };
  const commit = async (): Promise<void> => {
    if (disabled || saving || !control.revalidate()) return;
    const value = control.text.inputEl.value.trim();
    saving = true;
    setDisabled(disabled);
    try {
      if (value !== options.getValue().trim()) await options.onChange(value);
      draft = options.getValue();
      control.text.setValue(draft);
      await refresh();
    } catch {
      await refresh();
      control.validationEl.textContent = t('settings.cliInstallation.saveFailed');
      control.validationEl.classList.remove('claudian-hidden');
    } finally {
      saving = false;
      setDisabled(disabled);
    }
  };
  control.text.inputEl.addEventListener('blur', () => { void commit(); });
  control.text.inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void commit();
    }
  });
  setDisabled(disabled);
  installationRefreshers.set(card, refresh);
  void refresh();
  return {
    ...control,
    setDisabled,
    refresh,
  };
}
