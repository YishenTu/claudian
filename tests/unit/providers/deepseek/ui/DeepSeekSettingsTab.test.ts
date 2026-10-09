import { createMockEl } from '@test/helpers/MockElement';

import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

const sections: string[] = [];

jest.mock('obsidian', () => ({
  Setting: class {
    private name = '';
    setName(value: string) { this.name = value; return this; }
    setDesc() { return this; }
    setHeading() { sections.push(`heading:${this.name}`); return this; }
    addToggle(callback: (toggle: unknown) => void) {
      sections.push(`toggle:${this.name}`);
      const toggle = { toggleEl: { setAttribute: jest.fn() }, setValue: () => toggle, onChange: () => toggle };
      callback(toggle);
      return this;
    }
  },
}));
jest.mock('@/shared/settings/CLIInstallationSetting', () => ({ renderCLIInstallationSetting: () => sections.push('installation') }));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection: () => sections.push('environment') }));
jest.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: () => { sections.push('model picker'); return { refresh: jest.fn() }; } }));
jest.mock('@/shared/settings/ProviderModelEnablementWarning', () => ({
  renderLastEnabledProviderWarning: () => ({ showFor: jest.fn(), hide: jest.fn() }),
  renderProviderModelEnablementWarning: () => ({ refresh: jest.fn(), context: { notifyProviderModelOptionsChanged: jest.fn() } }),
}));

describe('DeepSeekSettingsTab', () => {
  it('puts code mode in its own Preset section after models', () => {
    const renderer = createDeepSeekSettingsTabRenderer({ cliResolver: { reset: jest.fn() } as never, modelCatalog: {} as never });
    renderer.render(createMockEl('div') as never, {
      plugin: { settings: { providerConfigs: {} }, storage: { installationKey: 'device:current' } },
      renderCustomContextLimits: jest.fn(),
    } as never);

    expect(sections).toEqual(['installation', 'heading:Models', 'model picker', 'heading:Preset', 'toggle:Enable code mode', 'environment']);
  });
});
