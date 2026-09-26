/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

const mockRenderedSettingNames: string[] = [];
const mockSettingDescriptionEls = new Map<string, MockContainer>();
const mockToggleChanges = new Map<string, (value: boolean) => Promise<void>>();
const mockTextChanges = new Map<string, (value: string) => Promise<void>>();
const mockGitStatusElements: Array<{
  attributes: Map<string, string>;
  className: string;
  parent: 'control' | 'name';
  title: string;
}> = [];

type MockChainableComponent = Record<string, jest.Mock> & {
  selectEl?: HTMLSelectElement;
};

jest.mock('obsidian', () => {
  const obsidian = jest.requireActual('../../../__mocks__/obsidian');

  class MockSetting {
    private name = '';
    readonly descEl = createContainer();
    readonly controlEl = {
      createSpan: jest.fn(() => createGitStatusElement('control')),
    };
    readonly nameEl = {
      createSpan: jest.fn(() => createGitStatusElement('name')),
    };

    constructor(_containerEl: HTMLElement) {}

    setName(name: string): this {
      this.name = name;
      mockRenderedSettingNames.push(name);
      mockSettingDescriptionEls.set(name, this.descEl);
      return this;
    }

    setDesc(_description: string): this {
      return this;
    }

    setClass(_className: string): this {
      return this;
    }

    setHeading(): this {
      return this;
    }

    addDropdown(callback: (dropdown: MockChainableComponent) => void): this {
      const dropdown = createChainableComponent();
      const label = document.createElement('label');
      label.textContent = this.name;
      const select = document.createElement('select');
      label.append(select);
      document.body.append(label);
      dropdown.selectEl = select;
      dropdown.addOption.mockImplementation((value: string, text: string) => {
        select.add(new Option(text, value));
        return dropdown;
      });
      dropdown.setValue.mockImplementation((value: string) => {
        select.value = value;
        return dropdown;
      });
      dropdown.onChange.mockImplementation((handler: (value: string) => Promise<void>) => {
        select.addEventListener('change', () => { void handler(select.value); });
        return dropdown;
      });
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
      const text = createTextComponent();
      (text.onChange as jest.Mock).mockImplementation(
        (handler: (value: string) => Promise<void>) => {
          mockTextChanges.set(this.name, handler);
          return text;
        },
      );
      callback(text);
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

  function createGitStatusElement(parent: 'control' | 'name') {
    const element = {
      attributes: new Map<string, string>(),
      className: '',
      parent,
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
      title: '',
    };
    mockGitStatusElements.push(element);
    return element;
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
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';

function createTab(enableDualPane: boolean): {
  tab: ClaudianSettingTab;
  plugin: Record<string, any>;
} {
  const settings = { ...DEFAULT_CLAUDIAN_SETTINGS, enableDualPane };
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

interface MockContainer extends Record<string, any> {
  readonly children: MockContainer[];
  readonly text?: string;
  click(): void;
}

function createContainer(options: { text?: string; cls?: string } = {}): MockContainer {
  const listeners = new Map<string, () => void>();
  const children: MockContainer[] = [];
  const attributes = new Map<string, string>();
  const element: MockContainer = {
    attributes,
    children,
    classList: {
      contains: (name: string) => options?.cls?.split(' ').includes(name) ?? false,
      add: jest.fn(),
      remove: jest.fn(),
    },
    ...options,
    click: () => listeners.get('click')?.(),
    createSpan: jest.fn((childOptions?: { text?: string }) => {
      const child = createContainer(childOptions);
      children.push(child);
      return child;
    }),
    createEl: jest.fn((_tag: string, childOptions?: { text?: string }) => {
      const child = createContainer(childOptions);
      children.push(child);
      return child;
    }),
    addEventListener: jest.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    setAttribute: jest.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    toggleClass: jest.fn(),
    title: '',
    empty: jest.fn(),
    setText: jest.fn(),
  };
  element.createDiv = jest.fn((childOptions?: { text?: string }) => {
    const child = createContainer(childOptions);
    children.push(child);
    return child;
  });
  return element;
}

function findContainer(root: MockContainer, text: string): MockContainer | null {
  if (root.text === text) return root;
  for (const child of root.children) {
    const match = findContainer(child, text);
    if (match) return match;
  }
  return null;
}


function renderSettingsTab(
  tab: ClaudianSettingTab,
  container = createContainer(),
): MockContainer {
  const [definition] = tab.getSettingDefinitions();
  if (
    !definition
    || !('render' in definition)
    || typeof definition.render !== 'function'
  ) {
    throw new Error('Expected a declarative settings renderer');
  }

  definition.render(
    { settingEl: container } as never,
    {} as never,
  );
  return container;
}

describe('ClaudianSettingTab display settings', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    mockRenderedSettingNames.length = 0;
    mockSettingDescriptionEls.clear();
    mockGitStatusElements.length = 0;
    mockToggleChanges.clear();
    mockTextChanges.clear();
  });

  it('shows title eligibility guidance and updates it after selection and catalog changes', async () => {
    jest.spyOn(ProviderRegistry, 'getTitleGenerationModelOptions').mockReturnValue([
      { value: 'claude-code/sonnet', label: 'Claude: Sonnet' },
    ]);
    const eligibility = jest.spyOn(ProviderRegistry, 'resolveTitleGenerationSelection')
      .mockImplementation(settings => settings.titleGenerationModel === 'claude-code/sonnet' ? { providerId: 'claude', model: 'claude-code/sonnet' } : null);
    const { tab, plugin } = createTab(true);
    plugin.settings.enableAutoTitleGeneration = true;
    plugin.settings.titleGenerationModel = '';
    renderSettingsTab(tab);
    expect(within(document.body).getByRole('status').textContent).toBe(t('settings.titleModel.unavailableWarning'));
    const menu = within(document.body).getByRole('combobox', { name: t('settings.titleModel.name') }) as HTMLSelectElement;
    expect(within(menu).queryByRole('option', { name: /Auto/ })).toBeNull();
    expect(menu.value).toBe('');
    expect(menu.options[0].disabled).toBe(true);
    expect(menu.required).toBe(true);
    expect(plugin.mutateSettings).not.toHaveBeenCalled();
    expect((await axe(menu.parentElement!)).violations).toEqual([]);
    fireEvent.change(menu, { target: { value: 'claude-code/sonnet' } });
    await waitFor(() => expect(within(document.body).queryByRole('status')).toBeNull());
    await waitFor(() => expect(plugin.settings.titleGenerationModel).toBe('claude-code/sonnet'));
    eligibility.mockReturnValue(null);
    tab.refreshModelOptions();
    expect(within(document.body).getByRole('status').textContent).toBe(t('settings.titleModel.unavailableWarning'));
    eligibility.mockReturnValue({ providerId: 'claude', model: 'claude-code/sonnet' });
    tab.refreshModelOptions();
    expect(within(document.body).queryByRole('status')).toBeNull();
    expect(await axe(menu.parentElement!)).toHaveNoViolations();
  });

  it('does not show title guidance when automatic titles are disabled', () => {
    const { tab, plugin } = createTab(true);
    plugin.settings.enableAutoTitleGeneration = false;
    renderSettingsTab(tab);
    expect(within(document.body).queryByRole('status')).toBeNull();
  });

  it('renders the custom settings surface through a declarative definition', () => {
    const { tab } = createTab(true);
    const container = createContainer();
    const [definition] = tab.getSettingDefinitions();

    expect(definition).toEqual(expect.objectContaining({
      name: 'Claudian',
      searchable: false,
    }));
    expect(Object.hasOwn(ClaudianSettingTab.prototype, 'display')).toBe(false);

    renderSettingsTab(tab, container);

    expect(container.empty).toHaveBeenCalledTimes(1);
    expect(container.addClass).toHaveBeenCalledWith('claudian-settings');
    expect(findContainer(container, t('settings.tabs.general'))).not.toBeNull();
  });

  it('saves timestamp preferences through the application settings owner', async () => {
    const { tab, plugin } = createTab(true);
    const firstView = { refreshMessageTimestamps: jest.fn() };
    const secondView = { refreshMessageTimestamps: jest.fn() };
    plugin.getAllViews.mockReturnValue([firstView, secondView]);
    let finishSave!: () => void;
    plugin.mutateSettings.mockImplementation(async (mutation: (settings: typeof plugin.settings) => void) => {
      mutation(plugin.settings);
      await new Promise<void>(resolve => { finishSave = resolve; });
    });
    (tab as any).renderGeneralTab(createContainer());

    const change = mockToggleChanges.get(t('settings.showMessageTimestamps.name'))!(true);
    expect(firstView.refreshMessageTimestamps).not.toHaveBeenCalled();
    expect(secondView.refreshMessageTimestamps).not.toHaveBeenCalled();
    finishSave();
    await change;

    expect(plugin.settings.showMessageTimestamps).toBe(true);
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the dual-pane position only while dual-pane mode is enabled', () => {
    const enabled = createTab(true);
    (enabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.dualPaneSide.name'));

    document.body.replaceChildren();
    mockRenderedSettingNames.length = 0;
    const disabled = createTab(false);
    (disabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).not.toContain(t('settings.dualPaneSide.name'));
    expect(mockRenderedSettingNames).toContain(t('settings.restoreTabsOnStartup.name'));
  });

  it('rerenders display settings after dual-pane mode changes', async () => {
    const { tab, plugin } = createTab(true);
    const update = jest.spyOn(tab, 'update').mockImplementation();
    (tab as any).renderGeneralTab(createContainer());

    await mockToggleChanges.get(t('settings.enableDualPane.name'))?.(false);

    expect(plugin.settings.enableDualPane).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('renders and updates the startup tab restore toggle', async () => {
    const { tab, plugin } = createTab(true);
    (tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.restoreTabsOnStartup.name'));

    await mockToggleChanges.get(t('settings.restoreTabsOnStartup.name'))?.(false);

    expect(plugin.settings.restoreTabsOnStartup).toBe(false);
  });

  it('keeps Provider initialization lazy and does not mutate chat selection on navigation', async () => {
    jest.spyOn(ProviderRegistry, 'getRegisteredProviderIds')
      .mockReturnValue(['claude', 'codex']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName')
      .mockImplementation(providerId => providerId.toUpperCase());
    jest.spyOn(ProviderRegistry, 'getTitleGenerationModelOptions').mockReturnValue([]);
    const ensureInitialized = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);
    ensureInitialized.mockClear();
    jest.spyOn(ProviderWorkspaceRegistry, 'getSettingsTabRenderer').mockReturnValue(null);
    const { tab, plugin } = createTab(true);
    renderSettingsTab(tab);
    expect(ensureInitialized).not.toHaveBeenCalled();

    (tab as any).activeTab = 'providers';
    renderSettingsTab(tab);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureInitialized).toHaveBeenCalledWith(
      expect.anything(),
      plugin.settings.settingsProvider,
      'settings-tab',
    );
    expect(plugin.mutateSettings).not.toHaveBeenCalled();
  });

  it('initializes each Provider settings tab once and reuses its rendered content', async () => {
    jest.spyOn(ProviderRegistry, 'getRegisteredProviderIds')
      .mockReturnValue(['claude', 'codex']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName')
      .mockImplementation(providerId => providerId.toUpperCase());
    jest.spyOn(ProviderRegistry, 'getTitleGenerationModelOptions').mockReturnValue([]);
    const ensureInitialized = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);
    ensureInitialized.mockClear();
    jest.spyOn(ProviderWorkspaceRegistry, 'getSettingsTabRenderer').mockReturnValue(null);
    const { tab } = createTab(true);
    const container = createContainer();
    (tab as any).activeTab = 'providers';

    renderSettingsTab(tab, container);
    await Promise.resolve();
    await Promise.resolve();
    findContainer(container, 'CODEX')?.click();
    await Promise.resolve();
    await Promise.resolve();
    findContainer(container, 'CLAUDE')?.click();
    await Promise.resolve();

    expect(ensureInitialized).toHaveBeenCalledTimes(2);
    expect(ensureInitialized.mock.calls.map(([, providerId]) => providerId))
      .toEqual(['claude', 'codex']);
  });
});
