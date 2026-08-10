import * as fs from 'fs';

import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { claudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockRenderNativeMcpSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockSlashCommandSettings = jest.fn();
const mockPluginSettingsManager = jest.fn();
const mockCliResolverReset = jest.fn();
const mockAgentManagerLoadAgents = jest.fn().mockResolvedValue(undefined);
const mockVaultCommandRepository = {};

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((
      settings: Record<string, unknown>,
      providerId: string,
      enabled: boolean,
    ) => {
      const providerConfigs = settings.providerConfigs as Record<string, { enabled: boolean }>;
      providerConfigs[providerId].enabled = enabled;
      return true;
    }),
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

jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

jest.mock('@/shared/settings/NativeMcpSettingsSection', () => ({
  renderNativeMcpSettingsSection: (...args: unknown[]) => mockRenderNativeMcpSettingsSection(...args),
}));

jest.mock('@/providers/claude/app/ClaudeWorkspaceServices', () => ({
  getClaudeWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: mockCliResolverReset,
    },
    commandCatalog: {},
    vaultCommandRepository: mockVaultCommandRepository,
    agentManager: {
      loadAgents: mockAgentManagerLoadAgents,
    },
    agentStorage: {},
    pluginManager: {},
  })),
}));

jest.mock('@/providers/claude/ui/AgentSettings', () => ({
  AgentSettings: jest.fn(),
}));

jest.mock('@/providers/claude/ui/PluginSettingsManager', () => ({
  PluginSettingsManager: jest.fn((...args: unknown[]) => mockPluginSettingsManager(...args)),
}));

jest.mock('@/providers/claude/ui/SlashCommandSettings', () => ({
  SlashCommandSettings: class MockSlashCommandSettings {
    constructor(...args: unknown[]) {
      mockSlashCommandSettings(...args);
    }
  },
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
  toggleClass: jest.Mock;
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
    toggleClass: jest.fn(),
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
  const classes = new Set<string>();
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
    addClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
    }),
    removeClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.delete(item));
    }),
    toggleClass: jest.fn((cls: string, force: boolean) => {
      if (force) {
        classes.add(cls);
      } else {
        classes.delete(cls);
      }
    }),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      toggle: jest.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) {
            classes.delete(cls);
            return false;
          }
          classes.add(cls);
          return true;
        }
        if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return force;
      }),
      contains: jest.fn((cls: string) => classes.has(cls)),
    },
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
  const plugin: any = {
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
    runProviderExecutionTransition: jest.fn(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation()),
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
    },
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  plugin.applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[],
    mutation: (settings: any) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => plugin.runProviderExecutionTransition(providerIds, async () => {
    await plugin.mutateSettings(mutation);
    await onApplied?.();
  }));
  return plugin;
}

function createContext(plugin: any) {
  return {
    plugin,
    notifyProviderModelOptionsChanged: jest.fn(),
    renderAgentSkillSettings: jest.fn(),
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

  it('uses the current npm package wrapper path as the CLI placeholder', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const cliPathSetting = findSetting('settings.cliPath.name');
    const cliPathInput = cliPathSetting.textComponents[0];

    expect(cliPathInput.placeholder).toContain('cli-wrapper.cjs');
    expect(cliPathInput.placeholder).not.toContain('cli.js');
  });

  it('persists Claude enablement inside its execution transition and refreshes model options', async () => {
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['claude']);
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);
    const toggle = findSetting('settings.providerEnablement.name').toggleComponents[0];
    await toggle.onChangeCallback?.(false);

    expect(plugin.settings.providerConfigs.claude.enabled).toBe(false);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('claude');
  });

  it('warns when disabling Claude would leave no enabled provider', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();
    const coordinator = jest.requireMock('@/core/providers/ProviderSettingsCoordinator')
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);

    claudeSettingsTabRenderer.render(container, context);
    const warningCallIndex = container.createDiv.mock.calls.findIndex(
      ([options]: [{ text?: string }?]) => options?.text
        === 'settings.providerEnablement.lastProviderWarning',
    );
    const warningEl = container.createDiv.mock.results[warningCallIndex]?.value;
    const toggle = findSetting('settings.providerEnablement.name').toggleComponents[0];

    await toggle.onChangeCallback?.(false);

    expect(warningCallIndex).toBeGreaterThanOrEqual(0);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);
    expect(plugin.settings.providerConfigs.claude.enabled).toBe(true);
    expect(plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('persists and applies a CLI path inside the Claude execution transition', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => (
      String(filePath) === '/custom/claude'
    ));
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['claude']);
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    mockCliResolverReset.mockImplementation(() => {
      expect(transitionActive).toBe(true);
    });

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin));
    await findSetting('settings.cliPath.name')
      .textComponents[0]
      .onChangeCallback?.('/custom/claude');

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['claude'],
      expect.any(Function),
    );
    expect(plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['claude'],
      expect.any(Function),
      expect.any(Function),
    );
    expect(plugin.settings.providerConfigs.claude.cliPathsByHost).toEqual({
      'host-a': '/custom/claude',
    });
    expect(mockCliResolverReset).toHaveBeenCalledTimes(1);
  });

  it('directs MCP setup to the native Claude CLI', () => {
    const plugin = createPlugin();

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(mockRenderNativeMcpSettingsSection).toHaveBeenCalledWith(
      expect.anything(),
      {
        descriptionAfterCommand: 'settings.mcpServers.descAfterCommand',
        descriptionBeforeCommand: 'settings.mcpServers.descBeforeCommand',
        documentationLabel: 'settings.mcpServers.learnMore',
        documentationUrl: 'https://code.claude.com/docs/en/mcp',
        heading: 'settings.mcpServers.name',
        setupCommand: 'claude mcp add',
      },
    );
  });

  it('invalidates Claude plugin and agent configuration inside the execution transition', async () => {
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['claude']);
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    mockAgentManagerLoadAgents.mockImplementation(async () => {
      expect(transitionActive).toBe(true);
    });

    claudeSettingsTabRenderer.render(createContainer(), createContext(plugin));
    const dependencies = mockPluginSettingsManager.mock.calls[0]?.[1] as {
      restartTabs(): Promise<void>;
    };
    await dependencies.restartTabs();

    expect(mockAgentManagerLoadAgents).toHaveBeenCalledTimes(1);
  });

  it('does not render obsolete Opus and Sonnet 1M toggles', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.enableOpus1M.name');
    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.enableSonnet1M.name');
  });

  it('renders Models before Safety', () => {
    claudeSettingsTabRenderer.render(createContainer(), createContext(createPlugin()));

    const headings = createdSettings.filter(setting => setting.heading).map(setting => setting.name);
    expect(headings.indexOf('settings.models')).toBeLessThan(
      headings.indexOf('settings.safety'),
    );
  });

  it('renders and persists the Claude provider default from dynamic model options', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.claude.defaultModel = 'claude-code/claude-opus-4-6';
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const setting = findSetting('Default model');
    const dropdown = setting.dropdownComponents[0];
    expect(dropdown.value).toBe('claude-code/claude-opus-4-6');
    expect(dropdown.options).toEqual(expect.arrayContaining([
      { value: 'opus', label: 'Opus' },
      { value: 'claude-code/claude-opus-4-6', label: 'Opus 4.6' },
    ]));

    await dropdown.onChangeCallback?.('opus');

    expect(plugin.settings.providerConfigs.claude.defaultModel).toBe('opus');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('stores an unambiguous Claude environment slot as the provider default', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.claude.environmentVariables = [
      'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-enterprise',
      'ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-enterprise',
    ].join('\n');
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const dropdown = findSetting('Default model').dropdownComponents[0];
    expect(dropdown.value).toBe('claude-code/claude-opus-enterprise');

    await dropdown.onChangeCallback?.('claude-code/claude-sonnet-enterprise');

    expect(plugin.settings.providerConfigs.claude.defaultModel).toBe('sonnet');
  });

  it('keeps Claude CRUD on its explicit vault repository without the shared manager', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    expect(context.renderAgentSkillSettings).not.toHaveBeenCalled();
    expect(mockSlashCommandSettings).toHaveBeenCalledWith(
      expect.anything(),
      plugin.app,
      mockVaultCommandRepository,
    );
  });

  it('scopes custom model overrides to the Claude environment section', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const target = createContainer();

    claudeSettingsTabRenderer.render(createContainer(), context);

    const environmentOptions = mockRenderEnvironmentSettingsSection.mock.calls[0]?.[0];
    expect(environmentOptions).toEqual(expect.objectContaining({
      scope: 'provider:claude',
      renderCustomContextLimits: expect.any(Function),
    }));
    environmentOptions.renderCustomContextLimits(target);
    expect(context.renderCustomContextLimits).toHaveBeenCalledWith(target, 'claude');
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
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
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
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('claude');
  });
});
