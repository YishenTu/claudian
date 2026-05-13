import * as fs from 'fs';

import { OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES } from '@/providers/opencode/settings';
import { opencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockBroadcastToProviderTabs = jest.fn().mockResolvedValue(undefined);
const mockRefreshAgentMentions = jest.fn().mockResolvedValue(undefined);
const mockInvalidateProviderCommandCaches = jest.fn();
const mockRefreshModelSelector = jest.fn();
const mockCliResolverReset = jest.fn();
const mockAgentStorage = {};
const mockCreatedAgentSettings: Array<{
  app: unknown;
  containerEl: unknown;
  onChanged?: () => Promise<void> | void;
  storage: unknown;
}> = [];

jest.mock('fs');
jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
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

jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
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
    addEventListener: jest.fn(),
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
      return child;
    }),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  const viewA = {
    getTabManager: jest.fn(() => ({
      broadcastToProviderTabs: mockBroadcastToProviderTabs,
    })),
    invalidateProviderCommandCaches: mockInvalidateProviderCommandCaches,
    refreshModelSelector: mockRefreshModelSelector,
  };
  const viewB = {
    getTabManager: jest.fn(() => ({
      broadcastToProviderTabs: mockBroadcastToProviderTabs,
    })),
    invalidateProviderCommandCaches: mockInvalidateProviderCommandCaches,
    refreshModelSelector: mockRefreshModelSelector,
  };

  return {
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
    getView: jest.fn(() => viewA),
    getAllViews: jest.fn(() => [viewA, viewB]),
  };
}

function createContext(plugin: any) {
  return {
    plugin,
    renderHiddenProviderCommandSetting: jest.fn(),
    refreshModelSelectors: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string): MockSettingRecord {
  const setting = createdSettings.find((candidate) => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('OpencodeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    createdElements.length = 0;
    mockCreatedAgentSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('stores the CLI path per host and resets active runtime state across all views', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/custom/opencode');
    const plugin = createPlugin();

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const cliPathSetting = findSetting('CLI Path (host-a)');
    await cliPathSetting.textComponents[0].onChangeCallback?.('/custom/opencode');

    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({
      'host-a': '/custom/opencode',
    });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockCliResolverReset).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToProviderTabs).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToProviderTabs).toHaveBeenCalledWith(
      'opencode',
      expect.any(Function),
    );
    expect(mockInvalidateProviderCommandCaches).toHaveBeenCalledTimes(2);
    expect(mockRefreshModelSelector).toHaveBeenCalledTimes(2);
  });

  it('renders a notice explaining where vault-level commands and skills are managed', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    opencodeSettingsTabRenderer.render(createContainer(), context);

    expect(findSetting('Commands and Skills').heading).toBe(true);
    expect(context.renderHiddenProviderCommandSetting).toHaveBeenCalledWith(
      expect.anything(),
      'opencode',
      expect.objectContaining({
        name: 'Hidden Commands and Skills',
        desc: 'Hide specific OpenCode commands and skills from the dropdown. Enter names without the leading slash, one per line.',
      }),
    );

    expect(createdElements).toContainEqual({
      cls: 'setting-item-description',
      tag: 'p',
      text: 'OpenCode can auto-detect vault-level Claude slash commands from .claude/commands/ and skills from .claude/skills/, .codex/skills/, and .agents/skills/. Manage those entries in the Claude or Codex settings tab. This setting only hides entries from the OpenCode dropdown.',
    });
  });

  it('renders vault subagent settings and refreshes runtime state when they change', async () => {
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
    expect(mockBroadcastToProviderTabs).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToProviderTabs).toHaveBeenCalledWith(
      'opencode',
      expect.any(Function),
    );
    expect(mockInvalidateProviderCommandCaches).toHaveBeenCalledTimes(2);
    expect(mockInvalidateProviderCommandCaches).toHaveBeenCalledWith(['opencode']);
    expect(mockRefreshModelSelector).toHaveBeenCalledTimes(2);
  });

  it('passes the default Exa env var into the environment section copy', () => {
    const plugin = createPlugin();

    opencodeSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      desc: expect.stringContaining(OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES),
      placeholder: `${OPENCODE_DEFAULT_ENVIRONMENT_VARIABLES}\nOPENCODE_DB=/path/to/opencode.db`,
    }));
  });
});
