/** @jest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { getDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

jest.mock('obsidian', () => {
  class Setting {
    settingEl: HTMLElement;
    constructor(container: HTMLElement) { this.settingEl = container.createDiv(); }
    setName(value: string) { this.settingEl.createDiv({ text: value }); return this; }
    setDesc(value: string) { this.settingEl.createDiv({ text: value }); return this; }
    setHeading() { return this; }
    addToggle(callback: (toggle: unknown) => void) {
      const toggleEl = this.settingEl.createEl('input', { attr: { type: 'checkbox', role: 'switch' } });
      const toggle = {
        toggleEl,
        setValue(value: boolean) { toggleEl.checked = value; return this; },
        setDisabled(value: boolean) { toggleEl.disabled = value; return this; },
        onChange(fn: (value: boolean) => Promise<void>) {
          toggleEl.addEventListener('change', () => { void fn(toggleEl.checked); });
          return this;
        },
      };
      callback(toggle);
      return this;
    }
    addText(callback: (text: unknown) => void) {
      const inputEl = this.settingEl.createEl('input');
      const text = {
        inputEl,
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
        setValue(value: string) { inputEl.value = value; return this; },
        onChange(fn: (value: string) => void) { inputEl.addEventListener('input', () => fn(inputEl.value)); return this; },
      };
      callback(text);
      return this;
    }
  }
  return { Setting, Modal: class {}, Notice: class {}, setIcon() {} };
});
jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'device:current',
}));
jest.mock('@/core/providers/cli/CLIInstallationProbe', () => ({
  probeCLIInstallation: async () => ({ path: null, version: null, source: 'auto' }),
}));
jest.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: () => ({ refresh: jest.fn() }) }));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection: jest.fn() }));

function createHost(deepseekEnabled: boolean) {
  const transitions: string[][] = [];
  let transitionActive = false;
  const mutationsInsideTransition: boolean[] = [];
  const host: any = {
    settings: { providerConfigs: { claude: { enabled: !deepseekEnabled }, deepseek: { enabled: deepseekEnabled } } },
    storage: { installationKey: 'device:current' },
    getResolvedProviderCliPath: async () => null,
    mutateSettings: jest.fn(async (mutation: (settings: Record<string, unknown>) => void) => {
      mutationsInsideTransition.push(transitionActive);
      mutation(host.settings);
    }),
    runProviderExecutionTransition: jest.fn(async (providerIds: string[], run: () => Promise<unknown>) => {
      transitions.push(providerIds);
      transitionActive = true;
      try { return await run(); } finally { transitionActive = false; }
    }),
  };
  host.applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[], mutation: (settings: Record<string, unknown>) => void, onApplied?: () => void,
  ) => host.runProviderExecutionTransition(providerIds, async () => {
    await host.mutateSettings(mutation);
    onApplied?.();
  }));
  return { host, transitions, mutationsInsideTransition };
}

function render(deepseekEnabled = true) {
  const fixture = createHost(deepseekEnabled);
  const cliResolver = { reset: jest.fn() };
  const container = document.body.createDiv();
  const context = { plugin: fixture.host, notifyProviderModelOptionsChanged: jest.fn(), renderCustomContextLimits: jest.fn() };
  createDeepSeekSettingsTabRenderer({ cliResolver: cliResolver as never, modelCatalog: {} as never })
    .render(container, context as never);
  return { ...fixture, cliResolver, context, container, ui: within(container) };
}

describe('DeepSeekSettingsTab', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('persists the code-mode preference from its accessibly named switch', async () => {
    const { host, container, ui } = render();
    const toggle = ui.getByRole('switch', { name: 'Enable code mode' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).codeMode).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).codeMode).toBe(false));
    expect(host.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('applies a CLI path for this computer as a provider runtime change and resets resolution afterwards', async () => {
    const { host, transitions, mutationsInsideTransition, cliResolver, ui } = render();
    cliResolver.reset.mockImplementation(() => {
      expect(getDeepSeekProviderSettings(host.settings).cliPathsByHost).toEqual({ 'device:current': '/opt/dsh' });
    });
    fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
    const input = ui.getByRole('textbox', { name: 'CLI path' });
    fireEvent.input(input, { target: { value: ' /opt/dsh ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(cliResolver.reset).toHaveBeenCalledTimes(1));
    expect(host.applyProviderRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition).toEqual([true]);
    expect(getDeepSeekProviderSettings(host.settings).cliPathsByHost).toEqual({ 'device:current': '/opt/dsh' });
  });

  it('commits enablement inside the DeepSeek execution transition', async () => {
    const { host, transitions, mutationsInsideTransition, context, ui } = render(false);
    const toggle = ui.getByRole('switch', { name: 'Enable DeepSeek Harness' }) as HTMLInputElement;

    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true));
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition).toEqual([true]);
    await waitFor(() => expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('deepseek'));
    expect(toggle.checked).toBe(true);

    host.settings.providerConfigs.claude.enabled = false;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true);
    expect(transitions).toEqual([['deepseek']]);
  });
});
