import * as fs from 'fs';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import {
  getOpencodeProviderSettings,
  OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
} from '@/providers/opencode/settings';
import { opencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockRefreshAgentMentions = jest.fn().mockResolvedValue(undefined);
const mockCliResolverReset = jest.fn();
const mockMetadataLoadCatalog = jest.fn().mockResolvedValue(false);
const mockMetadataWarmModel = jest.fn().mockResolvedValue(false);
const mockAgentStorage = {};
const mockCreatedAgentSettings: Array<{
  app: unknown;
  containerEl: unknown;
  onChanged?: () => Promise<void> | void;
  storage: unknown;
}> = [];

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((settings: Record<string, unknown>, providerId: string, enabled: boolean) => {
      const providerConfigs = settings.providerConfigs as Record<string, { enabled: boolean }>;
      providerConfigs[providerId].enabled = enabled;
      return true;
    }),
  },
}));
jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public settingEl = { addClass: jest.fn() };
    public textComponents: MockTextComponent[] = [];
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

jest.mock('@/providers/opencode/ui/OpencodeAgentSettings', () => ({
  OpencodeAgentSettings: class MockOpencodeAgentSettings {
    constructor(
      containerEl: unknown,
      storage: unknown,
      app: unknown,
      onChanged?: () => Promise<void> | void,
    ) {
      mockCreatedAgentSettings.push({
        app,
        containerEl,
        onChanged,
        storage,
      });
    }
  },
}));

jest.mock('@/providers/opencode/app/OpencodeWorkspaceServices', () => ({
  maybeGetOpencodeWorkspaceServices: jest.fn(() => ({
    agentStorage: mockAgentStorage,
    cliResolver: {
      reset: mockCliResolverReset,
    },
    metadataService: {
      loadCatalog: mockMetadataLoadCatalog,
      warmModelMetadata: mockMetadataWarmModel,
    },
    refreshAgentMentions: mockRefreshAgentMentions,
  })),
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
  inputEl: {
    value: string;
    style: Record<string, string>;
    addClass: jest.Mock;
    toggleClass: jest.Mock;
  };
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: jest.MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

type MockSettingRecord = {
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  toggleComponents: MockToggleComponent[];
};

type MockElementRecord = {
  cls?: string;
  tag?: string;
  text?: string;
};

const createdSettings: MockSettingRecord[] = [];
const createdElements: MockElementRecord[] = [];
const createdDomElements: any[] = [];

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = {
    value: '',
    style: {},
    addClass: jest.fn(),
    toggleClass: jest.fn(),
  };
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
  const eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const element: any = {
    value: '',
    checked: false,
    open: false,
    placeholder: '',
    title: '',
    style: {},
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
    appendText: jest.fn(),
    setText: jest.fn((value: string) => {
      element.text = value;
    }),
    empty: jest.fn(),
    setAttribute: jest.fn(),
    addEventListener: jest.fn((type: string, callback: (...args: unknown[]) => void) => {
      const listeners = eventListeners.get(type) ?? [];
      listeners.push(callback);
      eventListeners.set(type, listeners);
    }),
    dispatchMockEvent: async (type: string, event?: unknown) => {
      for (const listener of eventListeners.get(type) ?? []) {
        await listener(event);
      }
    },
    blur: jest.fn(),
    createEl: jest.fn((_tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = _tag;
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      if (attrs && typeof attrs.text === 'string') {
        child.text = attrs.text;
      }
      if (attrs && typeof attrs.value === 'string') {
        child.value = attrs.value;
      }
      if (attrs && typeof attrs.type === 'string') {
        child.type = attrs.type;
      }
      createdElements.push({
        cls: child.cls,
        tag: child.tag,
        text: child.text,
      });
      createdDomElements.push(child);
      return child;
    }),
    createDiv: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      createdElements.push({
        cls: child.cls,
        tag: child.tag,
        text: child.text,
      });
      createdDomElements.push(child);
      return child;
    }),
    createSpan: jest.fn((_attrs?: Record<string, unknown>) => createElement()),
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      createdElements.push({
        cls: child.cls,
        tag: child.tag,
        text: child.text,
      });
      createdDomElements.push(child);
      return child;
    }),
    createEl: jest.fn((tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = tag;
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      if (attrs && typeof attrs.text === 'string') {
        child.text = attrs.text;
      }
      createdElements.push({
        cls: child.cls,
        tag: child.tag,
        text: child.text,
      });
      createdDomElements.push(child);
      return child;
    }),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    settings: {
      providerConfigs: {
        opencode: {
          availableModes: [],
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [],
          enabled: true,
          environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
          modelAliases: {},
          preferredThinkingByModel: {},
          selectedMode: '',
          visibleModels: [],
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
  };
  plugin.runProviderExecutionTransition = jest.fn(async (
    _providerIds: string[],
    mutation: () => Promise<unknown>,
  ) => mutation());
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
    providerId: 'opencode',
    createSession: () => ({
      providerId: 'opencode',
      sessionInstanceId: 'opencode-settings-session',
      execute: jest.fn(),
      cancel: jest.fn(),
      getSnapshot: jest.fn().mockReturnValue({
        providerId: 'opencode',
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

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function findSetting(name: string): MockSettingRecord {
  const setting = createdSettings.find((candidate) => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

function findElement(tag: string, cls: string): any {
  const element = createdDomElements.find((candidate) => candidate.tag === tag && candidate.cls === cls);
  if (!element) {
    throw new Error(`Element not found: ${tag}.${cls}`);
  }
  return element;
}

describe('OpencodeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    createdElements.length = 0;
    createdDomElements.length = 0;
    mockCreatedAgentSettings.length = 0;
    jest.clearAllMocks();
    mockMetadataLoadCatalog.mockResolvedValue(false);
    mockMetadataWarmModel.mockResolvedValue(false);
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('refreshes title model options after OpenCode enablement changes', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);
    const enableSetting = findSetting('Enable OpenCode');
    expect(enableSetting.desc).toBe(
      'Make enabled OpenCode models available for new conversations. Existing sessions are preserved when disabled.',
    );
    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
  });

  it('commits enablement inside the OpenCode transition without launching metadata probes', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const dispose = acquireSettingsLease(registry);
    const plugin = createPlugin();
    plugin.settings.providerConfigs.opencode.enabled = false;
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => registry.runTransition(providerIds as ['opencode'], async () => {
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

    opencodeSettingsTabRenderer.render(createContainer(), context);
    const toggle = findSetting('Enable OpenCode').toggleComponents[0];
    await flushPromises();
    mockMetadataLoadCatalog.mockClear();
    mockMetadataWarmModel.mockClear();
    await toggle.onChangeCallback?.(true);

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
    );
    expect(plugin.settings.providerConfigs.opencode.enabled).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.getProviderGeneration('opencode')).toBe(1);
    expect(mockMetadataLoadCatalog).not.toHaveBeenCalled();
    expect(mockMetadataWarmModel).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
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

      opencodeSettingsTabRenderer.render(createContainer(), context);
      const toggle = findSetting('Enable OpenCode').toggleComponents[0];
      toggle.value = false;
      toggle.setValue.mockClear();

      await expect(toggle.onChangeCallback?.(false)).rejects.toThrow(
        'enablement transition failed',
      );

      const persistedEnabled = plugin.settings.providerConfigs.opencode.enabled;
      expect(persistedEnabled).toBe(mutateBeforeFailure ? false : true);
      expect(toggle.setValue).toHaveBeenCalledWith(persistedEnabled);
      expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    },
  );

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/my tools/opencode');
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation());
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));
    await findSetting('CLI path').textComponents[0].onChangeCallback?.('"/my tools/opencode"');

    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({
      'host-a': '"/my tools/opencode"',
    });
  });

  it('stores the CLI path and resets provider state inside an execution transition', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/custom/opencode');
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['opencode']);
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

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const cliPathSetting = findSetting('CLI path');
    await cliPathSetting.textComponents[0].onChangeCallback?.('/custom/opencode');

    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({
      'host-a': '/custom/opencode',
    });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockCliResolverReset).toHaveBeenCalledTimes(1);
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
    );
    expect(plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('renders the shared skill manager and keeps hidden runtime commands separate', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);

    expect(findSetting('Skills').heading).toBe(true);
    expect(context.renderAgentSkillSettings).toHaveBeenCalledWith(
      expect.anything(),
      'opencode',
    );
    expect(context.renderHiddenProviderCommandSetting).toHaveBeenCalledWith(
      expect.anything(),
      'opencode',
      expect.objectContaining({
        name: 'Hidden Commands and Skills',
        desc: 'Hide specific OpenCode commands and skills from the dropdown. Enter names without the leading slash, one per line.',
      }),
    );
  });

  it('directs MCP setup to the native OpenCode CLI', () => {
    const plugin = createPlugin();

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findSetting('MCP Servers').heading).toBe(true);
    const notice = findElement('div', 'claudian-mcp-settings-desc');
    const description = notice.createEl.mock.results[0].value;
    expect(description.appendText).toHaveBeenNthCalledWith(
      1,
      'OpenCode manages MCP servers through its own CLI. Configure them with ',
    );
    expect(description.createEl.mock.results[0].value.appendText)
      .toHaveBeenCalledWith('opencode mcp add');
    expect(description.appendText).toHaveBeenNthCalledWith(
      2,
      ' and they will be available in Claudian. ',
    );
    expect(description.createEl).toHaveBeenCalledWith('a', {
      href: 'https://opencode.ai/docs/mcp-servers/',
      text: 'Learn more',
    });
  });

  it('refreshes vault subagent state inside an execution transition', async () => {
    const plugin = createPlugin();

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findSetting('Subagents').heading).toBe(true);
    expect(createdElements).toContainEqual({
      cls: 'setting-item-description',
      tag: 'p',
      text: 'Manage vault-level OpenCode subagents from .opencode/agent/ and legacy .opencode/agents/. New entries are saved as subagent-only files and appear in the @mention menu.',
    });

    expect(mockCreatedAgentSettings).toHaveLength(1);
    expect(mockCreatedAgentSettings[0].storage).toBe(mockAgentStorage);

    await mockCreatedAgentSettings[0].onChanged?.();

    expect(mockRefreshAgentMentions).toHaveBeenCalledTimes(1);
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
    );
  });

  it('passes the default Exa env var into the environment section copy', () => {
    const plugin = createPlugin();

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      desc: expect.stringContaining(OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES),
      placeholder: `${OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES}\nOPENCODE_DB=/path/to/opencode.db`,
    }));
  });

  it('loads the OpenCode model catalog when the model browser is expanded', async () => {
    const plugin = createPlugin({
      providerConfigs: {
        opencode: {
          availableModes: [],
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [],
          enabled: true,
          environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
          modelAliases: {},
          preferredThinkingByModel: {},
          selectedMode: '',
          visibleModels: ['deepseek/deepseek-v4-pro'],
        },
      },
    });
    mockMetadataLoadCatalog.mockImplementation(async () => {
      plugin.settings.providerConfigs.opencode.discoveredModels = [
        { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
      ];
      return true;
    });
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);

    const catalogEl = findElement('details', 'claudian-provider-model-picker-catalog');
    catalogEl.open = true;
    await catalogEl.dispatchMockEvent('toggle');
    await flushPromises();

    expect(mockMetadataLoadCatalog).toHaveBeenCalledTimes(1);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledTimes(1);
  });

  it('loads the OpenCode model catalog immediately when a fresh picker starts expanded', async () => {
    const plugin = createPlugin({
      providerConfigs: {
        opencode: {
          availableModes: [],
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [],
          enabled: true,
          environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
          modelAliases: {},
          preferredThinkingByModel: {},
          selectedMode: '',
          visibleModels: [],
        },
      },
    });
    mockMetadataLoadCatalog.mockImplementation(async () => {
      plugin.settings.providerConfigs.opencode.discoveredModels = [
        { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
      ];
      return true;
    });
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockMetadataLoadCatalog).toHaveBeenCalledTimes(1);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledTimes(1);
  });

  it('loads the OpenCode catalog when saved models start with the browser collapsed', async () => {
    const plugin = createPlugin({
      providerConfigs: {
        opencode: {
          availableModes: [],
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [],
          enabled: true,
          environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
          modelAliases: {},
          preferredThinkingByModel: {},
          selectedMode: '',
          visibleModels: ['deepseek/deepseek-v4-pro'],
        },
      },
    });
    mockMetadataLoadCatalog.mockImplementation(async () => {
      plugin.settings.providerConfigs.opencode.discoveredModels = [
        { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
      ];
      return true;
    });
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockMetadataLoadCatalog).toHaveBeenCalledTimes(1);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledTimes(1);
  });

  it('warms and persists thinking metadata when a model is added to the visible list', async () => {
    mockMetadataWarmModel.mockResolvedValue(true);
    const plugin = createPlugin({
      providerConfigs: {
        opencode: {
          availableModes: [],
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [
            { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
          ],
          enabled: true,
          environmentVariables: OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES,
          modelAliases: {},
          preferredThinkingByModel: {},
          selectedMode: '',
          visibleModels: [],
        },
      },
    });
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);

    const checkboxEl = createdDomElements.find((element) => element.type === 'checkbox');
    if (!checkboxEl) {
      throw new Error('Expected model checkbox');
    }

    checkboxEl.checked = true;
    await checkboxEl.dispatchMockEvent('change');
    await flushPromises();

    expect(plugin.settings.providerConfigs.opencode.visibleModels).toEqual([
      'deepseek/deepseek-v4-pro',
    ]);
    expect(mockMetadataWarmModel).toHaveBeenCalledWith(
      'opencode:deepseek/deepseek-v4-pro',
    );
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
  });

  it('persists aliases through the shared model picker', async () => {
    const plugin = createPlugin({
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
          ],
          modelAliases: {},
          visibleModels: ['deepseek/deepseek-v4-pro'],
        },
      },
    });
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);

    const aliasInput = findElement('input', 'claudian-provider-model-picker-selected-alias');
    aliasInput.value = 'V4 Pro';
    await aliasInput.dispatchMockEvent('blur');
    await flushPromises();

    expect(getOpencodeProviderSettings(plugin.settings).modelAliases).toEqual({
      'deepseek/deepseek-v4-pro': 'V4 Pro',
    });
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
  });
});
