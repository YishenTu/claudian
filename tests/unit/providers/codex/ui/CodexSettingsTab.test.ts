import * as fs from 'fs';

import { codexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockBroadcastToAllTabs = jest.fn().mockResolvedValue(undefined);

jest.mock('fs');
jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public dropdownComponents: MockDropdownComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];
    public settingEl = { style: {} };

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

jest.mock('@/providers/codex/app/CodexWorkspaceServices', () => ({
  getCodexWorkspaceServices: jest.fn(() => ({
    commandCatalog: null,
    subagentStorage: {},
    refreshAgentMentions: jest.fn(),
  })),
}));

jest.mock('@/providers/codex/ui/CodexSkillSettings', () => ({
  CodexSkillSettings: jest.fn(),
}));

jest.mock('@/providers/codex/ui/CodexSubagentSettings', () => ({
  CodexSubagentSettings: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

jest.mock('@/utils/env', () => ({
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
  };
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
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
}> = [];

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = {
    value: '',
    style: {},
    addClass: jest.fn(),
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
      providerConfigs: {
        codex: {
          enabled: true,
          safeMode: 'workspace-write',
          cliPath: '',
          cliPathsByHost: {},
          reasoningSummary: 'detailed',
          environmentVariables: '',
          environmentHash: '',
          installationMethod: 'native-windows',
          installationMethodsByHost: {},
          wslDistroOverride: '',
          wslDistroOverridesByHost: {},
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    getView: jest.fn(() => ({
      getTabManager: jest.fn(() => ({
        broadcastToAllTabs: mockBroadcastToAllTabs,
      })),
    })),
    app: {
      vault: {
        adapter: {
          basePath: 'C:\\vault',
        },
      },
    },
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

    const cliPathSetting = findSetting('Codex CLI path (host-a)');
    expect(cliPathSetting.desc).toBe('Custom path to the local Codex CLI. Leave empty for auto-detection from PATH.');
    expect(cliPathSetting.textComponents[0].placeholder).toBe('/usr/local/bin/codex');

    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBeUndefined();
    expect(mockSaveSettings).toHaveBeenCalledTimes(0);
    expect(mockBroadcastToAllTabs).toHaveBeenCalledTimes(0);
  });

  it('accepts a Linux-side CLI command when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('Installation method');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('Codex CLI path (host-a)');
    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe('codex');
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(mockBroadcastToAllTabs).toHaveBeenCalled();
  });

  it('rejects a Windows-native CLI path when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          enabled: true,
          safeMode: 'workspace-write',
          cliPath: '',
          cliPathsByHost: {
            'host-a': 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
          },
          reasoningSummary: 'detailed',
          environmentVariables: '',
          environmentHash: '',
          installationMethod: 'native-windows',
          installationMethodsByHost: {},
          wslDistroOverride: '',
          wslDistroOverridesByHost: {},
        },
      },
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('Installation method');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('Codex CLI path (host-a)');
    await cliPathSetting.textComponents[0].onChangeCallback?.('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
    );
    expect(mockBroadcastToAllTabs).toHaveBeenCalledTimes(0);
  });
});
