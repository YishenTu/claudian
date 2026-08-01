import * as fs from 'fs';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { DEFAULT_CODEX_PROVIDER_SETTINGS } from '@/providers/codex/settings';
import { codexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockCodexCliResolverReset = jest.fn();
const mockRenderCodexModelPicker = jest.fn();
const mockRefreshModelCatalog = jest.fn().mockResolvedValue({ changed: false });

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((settings: Record<string, unknown>, _providerId: string, enabled: boolean) => {
      const providerConfigs = settings.providerConfigs as { codex: { enabled: boolean } };
      providerConfigs.codex.enabled = enabled;
      return true;
    }),
    reconcileTitleGenerationModelSelection: jest.fn((settings: Record<string, unknown>) => {
      const titleGenerationModel = settings.titleGenerationModel;
      const customModels = (
        settings.providerConfigs as { codex?: { customModels?: string } } | undefined
      )?.codex?.customModels ?? '';
      if (titleGenerationModel === 'my-custom-model' && customModels !== 'my-custom-model') {
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
    public settingEl = {
      style: {},
      toggleClass: jest.fn(),
      addClass: jest.fn(),
      removeClass: jest.fn(),
    };

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

jest.mock('@/providers/codex/app/CodexWorkspaceServices', () => ({
  getCodexWorkspaceServices: jest.fn(() => ({
    commandCatalog: null,
    subagentStorage: {},
    refreshAgentMentions: jest.fn(),
    refreshModelCatalog: mockRefreshModelCatalog,
    cliResolver: { reset: mockCodexCliResolverReset },
  })),
}));

jest.mock('@/providers/codex/ui/CodexModelPicker', () => ({
  renderCodexModelPicker: (...args: unknown[]) => mockRenderCodexModelPicker(...args),
}));

jest.mock('@/providers/codex/ui/CodexSubagentSettings', () => ({
  CodexSubagentSettings: jest.fn(),
}));

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

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

interface MockInputEl {
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  addClass: jest.Mock;
  toggleClass: jest.Mock;
  addEventListener: jest.Mock;
}

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    rows: 0,
    cols: 0,
    value: '',
    style: {},
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
      settingsProvider: 'codex',
      model: 'my-custom-model',
      titleGenerationModel: '',
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          customModels: 'my-custom-model',
          discoveredModels: [{
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            description: 'Latest frontier agentic coding model.',
            supportedReasoningEfforts: [{ value: 'low', description: 'Fast' }],
            defaultReasoningEffort: 'low',
            serviceTiers: [],
            defaultServiceTier: null,
            inputModalities: ['text', 'image'],
            isDefault: true,
          }],
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    runProviderExecutionTransition: jest.fn(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation()),
    app: {
      vault: {
        adapter: {
          basePath: 'C:\\vault',
        },
      },
    },
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

function createContext(plugin: any) {
  return {
    plugin,
    renderAgentSkillSettings: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    notifyProviderModelOptionsChanged: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function acquireSettingsLease(
  registry: ProviderExecutionLifecycleRegistry,
): jest.Mock {
  const dispose = jest.fn().mockResolvedValue(undefined);
  registry.acquire({
    providerId: 'codex',
    createSession: () => ({
      providerId: 'codex',
      sessionInstanceId: 'codex-settings-session',
      execute: jest.fn(),
      cancel: jest.fn(),
      getSnapshot: jest.fn().mockReturnValue({
        providerId: 'codex',
        revision: 0,
        status: 'idle',
      }),
      getStatus: jest.fn().mockReturnValue('idle'),
      onEvent: jest.fn().mockReturnValue(() => undefined),
      dispose,
    }),
  } as any, {} as any, 'chat');
  return dispose;
}

function findSetting(name: string) {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

function findOptionalSetting(name: string) {
  return createdSettings.find(candidate => candidate.name === name);
}

describe('CodexSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
  const originalPlatform = process.platform;

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('renders installation method and WSL distro override controls on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findSetting('Installation method').dropdownComponents).toHaveLength(1);
    expect(findSetting('WSL distro override').textComponents).toHaveLength(1);
  });

  it('hides Windows-only installation controls on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findOptionalSetting('Installation method')).toBeUndefined();
    expect(findOptionalSetting('WSL distro override')).toBeUndefined();
  });

  it('renders Models before Safety', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    codexSettingsTabRenderer.render(createContainer(), createContext(createPlugin()));

    const headings = createdSettings.filter(setting => setting.heading).map(setting => setting.name);
    expect(headings.indexOf('Models')).toBeLessThan(headings.indexOf('Safety'));
  });

  it('refreshes title model options after Codex enablement changes', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);
    const enableSetting = findSetting('Enable Codex');
    expect(enableSetting.desc).toBe(
      'Make enabled Codex models available for new conversations. Existing sessions are preserved when disabled.',
    );
    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('codex');
  });

  it('commits enablement inside the Codex transition without launching metadata discovery', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const dispose = acquireSettingsLease(registry);
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: false,
        },
      },
    });
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => registry.runTransition(providerIds as ['codex'], async () => {
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    }));
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);
    const toggle = findSetting('Enable Codex').toggleComponents[0];
    await toggle.onChangeCallback?.(true);

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['codex'],
      expect.any(Function),
    );
    expect(plugin.settings.providerConfigs.codex.enabled).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.getProviderGeneration('codex')).toBe(1);
    expect(mockRefreshModelCatalog).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('codex');
    await registry.dispose();
  });

  it.each([
    ['before mutation', false],
    ['after mutation', true],
  ] as const)(
    'resynchronizes the enable toggle when the transition fails %s',
    async (_phase, mutateBeforeFailure) => {
      const plugin = createPlugin();
      plugin.runProviderExecutionTransition.mockImplementation(async (
        _providerIds: string[],
        mutation: () => Promise<unknown>,
      ) => {
        if (mutateBeforeFailure) await mutation();
        throw new Error('enablement transition failed');
      });
      const context = createContext(plugin);

      codexSettingsTabRenderer.render(createContainer(), context);
      const toggle = findSetting('Enable Codex').toggleComponents[0];
      toggle.value = false;
      toggle.setValue.mockClear();

      await expect(toggle.onChangeCallback?.(false)).rejects.toThrow(
        'enablement transition failed',
      );

      const persistedEnabled = plugin.settings.providerConfigs.codex.enabled;
      expect(persistedEnabled).toBe(mutateBeforeFailure ? false : true);
      expect(toggle.setValue).toHaveBeenCalledWith(persistedEnabled);
      expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    },
  );

  it('renders the app-server model visibility picker', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();

    codexSettingsTabRenderer.render(container, context);

    expect(mockRenderCodexModelPicker).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ plugin }),
      expect.objectContaining({ commandCatalog: null }),
    );
  });

  it('warns when Codex is enabled without any enabled models', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          visibleModels: [],
        },
      },
    });
    const context = createContext(plugin);
    const container = createContainer();

    codexSettingsTabRenderer.render(container, context);

    const warningCallIndex = container.createDiv.mock.calls.findIndex(
      ([options]: [{ text?: string }?]) => options?.text
        === 'No Codex models are enabled. Go to Models below and enable at least one model.',
    );
    const warningEl = container.createDiv.mock.results[warningCallIndex]?.value;
    expect(warningCallIndex).toBeGreaterThanOrEqual(0);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);

    plugin.settings.providerConfigs.codex.customModels = 'gpt-custom';
    const pickerContext = mockRenderCodexModelPicker.mock.calls[0][1];
    pickerContext.notifyProviderModelOptionsChanged('codex');

    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('codex');
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);
  });

  it('renders the fixed-root shared skill manager', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();

    codexSettingsTabRenderer.render(container, context);

    expect(context.renderAgentSkillSettings).toHaveBeenCalledWith(
      container,
      'codex',
    );
  });

  it('uses host-native CLI path behavior on non-Windows even when WSL is saved', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          enabled: true,
          safeMode: 'workspace-write',
          cliPath: '',
          cliPathsByHost: {},
          reasoningSummary: 'detailed',
          environmentVariables: '',
          environmentHash: '',
          installationMethod: 'wsl',
          installationMethodsByHost: {
            'host-a': 'wsl',
          },
          wslDistroOverride: 'Ubuntu',
          wslDistroOverridesByHost: {
            'host-a': 'Ubuntu',
          },
        },
      },
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const cliPathSetting = findSetting('Codex CLI path');
    expect(cliPathSetting.desc).toBe('Custom path to the local Codex CLI. Leave empty to prefer known Codex installs, then PATH.');
    expect(cliPathSetting.textComponents[0].placeholder).toBe('/usr/local/bin/codex');

    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBeUndefined();
    expect(mockSaveSettings).toHaveBeenCalledTimes(0);
  });

  it('accepts a Linux-side CLI command when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin();
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('Installation method');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('Codex CLI path');
    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe('codex');
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['codex'],
      expect.any(Function),
    );
    expect(mockCodexCliResolverReset).toHaveBeenCalledTimes(2);
    expect(mockRefreshModelCatalog).toHaveBeenCalledTimes(1);
  });

  it('rejects a Windows-native CLI path when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          cliPathsByHost: {
            'host-a': 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
          },
        },
      },
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('Installation method');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('Codex CLI path');
    await cliPathSetting.textComponents[0].onChangeCallback?.('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
    );
  });

  it('does not render the legacy custom models textarea', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(createdSettings.some(setting => setting.name === 'Custom models')).toBe(false);
  });
});
