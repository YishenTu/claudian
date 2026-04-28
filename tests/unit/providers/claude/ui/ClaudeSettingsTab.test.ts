import * as fs from 'fs';

import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { claudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    reconcileTitleGenerationModelSelection: jest.fn((settings: Record<string, unknown>) => {
      const titleGenerationModel = settings.titleGenerationModel;
      const customModels = (
        settings.providerConfigs as { claude?: { customModels?: string } } | undefined
      )?.claude?.customModels ?? '';
      if (titleGenerationModel === 'claude-opus-4-6' && customModels !== 'claude-opus-4-6') {
        settings.titleGenerationModel = '';
        return true;
      }
      return false;
    }),
  },
}));

jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public textAreaComponents: MockTextAreaComponent[] = [];
    public dropdownComponents: MockDropdownComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string) {
      this.name = name;
      return this;
    }

    setDesc(desc: string) {
      this.desc = desc;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (text: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addTextArea(callback: (text: MockTextAreaComponent) => void) {
      const component = createTextAreaComponent();
      this.textAreaComponents.push(component);
      callback(component);
      return this;
    }

    addDropdown(callback: (dropdown: MockDropdownComponent) => void) {
      const component = createDropdownComponent();
      this.dropdownComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return {
    Setting: MockSetting,
  };
});

jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

jest.mock('@/features/settings/ui/McpSettingsManager', () => ({
  McpSettingsManager: jest.fn(),
}));

jest.mock('@/providers/claude/app/ClaudeWorkspaceServices', () => ({
  getClaudeWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: jest.fn(),
    },
    commandCatalog: {},
    agentManager: {},
    agentStorage: {},
    mcpStorage: {},
    pluginManager: {},
  })),
}));

jest.mock('@/providers/claude/ui/AgentSettings', () => ({
  AgentSettings: jest.fn(),
}));

jest.mock('@/providers/claude/ui/PluginSettingsManager', () => ({
  PluginSettingsManager: jest.fn(),
}));

jest.mock('@/providers/claude/ui/SlashCommandSettings', () => ({
  SlashCommandSettings: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
  };
});

interface MockInputEl {
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  addClass: jest.Mock;
  addEventListener: jest.Mock;
}

interface MockTextComponent {
  value: string;
  placeholder: string;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.MockedFunction<(value: string) => MockTextComponent>;
  setValue: jest.MockedFunction<(value: string) => MockTextComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockTextComponent>;
  inputEl: MockInputEl;
}

interface MockTextAreaComponent extends MockTextComponent {
  trigger: (event: string) => Promise<void>;
}

interface MockDropdownComponent {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  addOption: jest.MockedFunction<(value: string, label: string) => MockDropdownComponent>;
  setValue: jest.MockedFunction<(value: string) => MockDropdownComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockDropdownComponent>;
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: jest.MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

const createdSettings: Array<{
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  textAreaComponents: MockTextAreaComponent[];
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
}> = [];

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    rows: 0,
    cols: 0,
    value: '',
    style: {},
    dataset: {},
    addClass: jest.fn(),
    addEventListener: jest.fn((event: string, handler: () => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    _listeners: listeners,
  };
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = createInputEl();
  component.setPlaceholder = jest.fn((value: string) => {
    component.placeholder = value;
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createTextAreaComponent(): MockTextAreaComponent {
  const component = createTextComponent() as MockTextAreaComponent;
  component.trigger = async (event: string) => {
    const handlers = (component.inputEl as ReturnType<typeof createInputEl>)._listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.value = '';
  component.options = [];
  component.onChangeCallback = null;
  component.addOption = jest.fn((value: string, label: string) => {
    component.options.push({ value, label });
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.value = false;
  component.onChangeCallback = null;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: boolean) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createElement(): any {
  const element: any = {
    value: '',
    style: {},
    dataset: {},
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
    createDiv: jest.fn(() => createElement()),
    createSpan: jest.fn(() => createElement()),
    setText: jest.fn(),
    empty: jest.fn(),
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    createEl: jest.fn(() => createElement()),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      settingsProvider: 'claude',
      model: 'claude-opus-4-6',
      titleGenerationModel: '',
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          customModels: 'claude-opus-4-6',
          lastModel: 'sonnet',
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    normalizeModelVariantSettings: jest.fn(() => false),
    getView: jest.fn(() => ({
      getTabManager: jest.fn(() => ({
        broadcastToAllTabs: jest.fn().mockResolvedValue(undefined),
      })),
    })),
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
    },
  };
}

function createContext(plugin: any) {
  return {
    plugin,
    refreshModelSelectors: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string) {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('ClaudeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('does not switch the active model while the custom models textarea is mid-edit', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const customModelsSetting = findSetting('settings.customModels.name');
    const customModelsTextArea = customModelsSetting.textAreaComponents[0];

    await customModelsTextArea.onChangeCallback?.('claude-opus-4-7');

    expect(plugin.settings.providerConfigs.claude.customModels).toBe('claude-opus-4-6');
    expect(plugin.settings.model).toBe('claude-opus-4-6');
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(context.refreshModelSelectors).not.toHaveBeenCalled();
  });

  it('offers auto as a Claude safe mode and persists it', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const safeModeSetting = findSetting('settings.claudeSafeMode.name');
    const safeModeDropdown = safeModeSetting.dropdownComponents[0];

    expect(safeModeDropdown.options).toEqual([
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'auto', label: 'auto' },
      { value: 'default', label: 'default' },
    ]);

    await safeModeDropdown.onChangeCallback?.('auto');

    expect(plugin.settings.providerConfigs.claude.safeMode).toBe('auto');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('reconciles removed custom models on blur and clears stale title model selections', async () => {
    const plugin = createPlugin({
      titleGenerationModel: 'claude-opus-4-6',
    });
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const customModelsSetting = findSetting('settings.customModels.name');
    const customModelsTextArea = customModelsSetting.textAreaComponents[0];

    await customModelsTextArea.onChangeCallback?.('claude-opus-4-7');
    await customModelsTextArea.trigger('blur');

    expect(plugin.settings.providerConfigs.claude.customModels).toBe('claude-opus-4-7');
    expect(plugin.settings.model).toBe('sonnet');
    expect(plugin.settings.titleGenerationModel).toBe('');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });
});
