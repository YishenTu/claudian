const mockRenderAgentSkillSettings = jest.fn();

jest.mock('node:fs');
jest.mock('obsidian', () => ({
  Notice: class {},
  Setting: class {
    constructor(_container: unknown) {}
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addToggle(callback: (component: unknown) => void) {
      callback({
        setValue() { return this; },
        onChange() { return this; },
      });
      return this;
    }
    addDropdown(callback: (component: unknown) => void) {
      callback({
        addOption() { return this; },
        setValue() { return this; },
        onChange() { return this; },
      });
      return this;
    }
    addText(callback: (component: unknown) => void) {
      callback({
        inputEl: { toggleClass: jest.fn() },
        setPlaceholder() { return this; },
        setValue() { return this; },
        onChange() { return this; },
      });
      return this;
    }
  },
}));
jest.mock('@/providers/qoder/app/QoderWorkspaceServices', () => ({
  getQoderWorkspaceServices: () => ({
    cliResolver: { reset: jest.fn() },
    refreshModelCatalog: jest.fn().mockResolvedValue({ changed: false }),
  }),
}));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: jest.fn(),
}));
jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: jest.fn(),
}));
jest.mock('@/utils/env', () => ({
  getHostnameKey: () => 'host',
}));

import { qoderSettingsTabRenderer } from '@/providers/qoder/ui/QoderSettingsTab';

describe('QoderSettingsTab', () => {
  it('renders the shared .agents/skills manager', () => {
    const container = {
      createDiv: () => ({
        setText: jest.fn(),
        toggleClass: jest.fn(),
      }),
    } as unknown as HTMLElement;
    const plugin = {
      settings: {
        providerConfigs: {
          qoder: {
            enabled: true,
          },
        },
      },
    };

    qoderSettingsTabRenderer.render(container, {
      plugin,
      refreshModelSelectors: jest.fn(),
      refreshTitleGenerationModelOptions: jest.fn(),
      renderAgentSkillSettings: mockRenderAgentSkillSettings,
      renderCustomContextLimits: jest.fn(),
      renderHiddenProviderCommandSetting: jest.fn(),
    } as never);

    expect(mockRenderAgentSkillSettings).toHaveBeenCalledWith(container, 'qoder');
  });
});
