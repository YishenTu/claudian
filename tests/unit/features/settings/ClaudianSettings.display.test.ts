const mockRenderedSettingNames: string[] = [];
const mockToggleChanges = new Map<string, (value: boolean) => Promise<void>>();

type MockChainableComponent = Record<string, jest.Mock> & {
  selectEl?: { replaceChildren: jest.Mock };
};

jest.mock('obsidian', () => {
  const obsidian = jest.requireActual('../../../__mocks__/obsidian');

  class MockSetting {
    private name = '';

    constructor(_containerEl: HTMLElement) {}

    setName(name: string): this {
      this.name = name;
      mockRenderedSettingNames.push(name);
      return this;
    }

    setDesc(_description: string): this {
      return this;
    }

    setHeading(): this {
      return this;
    }

    addDropdown(callback: (dropdown: MockChainableComponent) => void): this {
      const dropdown = createChainableComponent();
      dropdown.selectEl = { replaceChildren: jest.fn() };
      callback(dropdown);
      return this;
    }

    addToggle(callback: (toggle: MockChainableComponent) => void): this {
      const toggle = createChainableComponent();
      toggle.onChange.mockImplementation((handler: (value: boolean) => Promise<void>) => {
        mockToggleChanges.set(this.name, handler);
        return toggle;
      });
      callback(toggle);
      return this;
    }

    addText(callback: (text: Record<string, unknown>) => void): this {
      callback(createTextComponent());
      return this;
    }

    addTextArea(callback: (text: Record<string, unknown>) => void): this {
      callback(createTextComponent());
      return this;
    }

    addSlider(callback: (slider: MockChainableComponent) => void): this {
      callback(createChainableComponent());
      return this;
    }
  }

  function createChainableComponent(): MockChainableComponent {
    const component: MockChainableComponent = {};
    for (const method of [
      'addOption',
      'setValue',
      'onChange',
      'setPlaceholder',
      'setLimits',
      'setDynamicTooltip',
    ]) {
      component[method] = jest.fn(() => component);
    }
    return component;
  }

  function createTextComponent(): Record<string, unknown> {
    return {
      ...createChainableComponent(),
      inputEl: {
        addClass: jest.fn(),
        addEventListener: jest.fn(),
        dataset: {},
        value: '',
        rows: 0,
        cols: 0,
      },
    };
  }

  return {
    ...obsidian,
    Setting: MockSetting,
  };
});

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';

function createTab(enableDualPane: boolean, enableFilePane = true): {
  tab: ClaudianSettingTab;
  plugin: Record<string, any>;
} {
  const settings = { ...DEFAULT_CLAUDIAN_SETTINGS, enableDualPane, enableFilePane };
  const plugin = {
    settings,
    mutateSettings: jest.fn(async (mutation: (value: typeof settings) => void) => {
      mutation(settings);
    }),
    getAllViews: jest.fn(() => [{ refreshDualPaneLayout: jest.fn() }]),
    notifyAgentSkillsChanged: jest.fn(),
    storage: {
      getAdapter: jest.fn(() => ({})),
    },
    warmExecutionPool: {
      reconcileLimit: jest.fn(),
    },
    providerHost: {
      settings,
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      applyEnvironmentVariables: jest.fn(),
    },
  };

  return {
    tab: new ClaudianSettingTab({} as any, plugin as any),
    plugin,
  };
}

function createContainer(): Record<string, jest.Mock> {
  const element: Record<string, jest.Mock> = {
    createSpan: jest.fn(() => ({})),
    createEl: jest.fn(() => ({ addEventListener: jest.fn() })),
    addEventListener: jest.fn(),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    toggleClass: jest.fn(),
    empty: jest.fn(),
    setText: jest.fn(),
  };
  element.createDiv = jest.fn(() => createContainer());
  return element;
}

describe('ClaudianSettingTab display settings', () => {
  beforeEach(() => {
    mockRenderedSettingNames.length = 0;
    mockToggleChanges.clear();
  });

  it('renders the dual-pane position only while dual-pane mode is enabled', () => {
    const enabled = createTab(true);
    (enabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.dualPaneSide.name'));
    expect(mockRenderedSettingNames).toContain(t('settings.enableFilePane.name'));
    expect(mockRenderedSettingNames.indexOf(t('settings.dualPaneSide.name')))
      .toBeLessThan(mockRenderedSettingNames.indexOf(t('settings.enableFilePane.name')));

    mockRenderedSettingNames.length = 0;
    const disabled = createTab(false);
    (disabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).not.toContain(t('settings.dualPaneSide.name'));
    expect(mockRenderedSettingNames).not.toContain(t('settings.enableFilePane.name'));
  });

  it('updates the file pane setting and refreshes open dual-pane views', async () => {
    const { tab, plugin } = createTab(true);
    const refreshDualPaneLayout = jest.fn();
    plugin.getAllViews.mockReturnValue([{ refreshDualPaneLayout }]);
    (tab as any).renderGeneralTab(createContainer());

    await mockToggleChanges.get(t('settings.enableFilePane.name'))?.(false);

    expect(plugin.settings.enableFilePane).toBe(false);
    expect(refreshDualPaneLayout).toHaveBeenCalledTimes(1);
  });

  it('rerenders display settings after dual-pane mode changes', async () => {
    const { tab, plugin } = createTab(true);
    const display = jest.spyOn(tab, 'display').mockImplementation();
    (tab as any).renderGeneralTab(createContainer());

    await mockToggleChanges.get(t('settings.enableDualPane.name'))?.(false);

    expect(plugin.settings.enableDualPane).toBe(false);
    expect(display).toHaveBeenCalledTimes(1);
  });
});
