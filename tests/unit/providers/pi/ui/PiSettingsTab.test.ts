import * as fs from 'node:fs';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockCliResolverReset = jest.fn();
const mockDiscoverModels = jest.fn();
const mockNotices: string[] = [];

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.Mock;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
}

interface MockTextComponent {
  inputEl: {
    toggleClass: jest.Mock;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.Mock;
  setValue: jest.Mock;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
}

interface MockButtonComponent {
  disabled: boolean;
  onClickCallback: (() => Promise<void> | void) | null;
  setButtonText: jest.Mock;
  setDisabled: jest.Mock;
  text: string;
  onClick(callback: () => Promise<void> | void): MockButtonComponent;
}

interface MockDropdownComponent {
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  options: Record<string, string>;
  setValue: jest.Mock;
  value: string;
  addOption(value: string, label: string): MockDropdownComponent;
  onChange(callback: (value: string) => Promise<void> | void): MockDropdownComponent;
}

class MockSetting {
  buttonComponents: MockButtonComponent[] = [];
  desc = '';
  dropdownComponents: MockDropdownComponent[] = [];
  heading = false;
  name = '';
  textComponents: MockTextComponent[] = [];
  toggleComponents: MockToggleComponent[] = [];

  constructor(_container: unknown) {
    createdSettings.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    const component = createToggleComponent();
    this.toggleComponents.push(component);
    callback(component);
    return this;
  }

  addText(callback: (text: MockTextComponent) => void): this {
    const component = createTextComponent();
    this.textComponents.push(component);
    callback(component);
    return this;
  }

  addButton(callback: (button: MockButtonComponent) => void): this {
    const component = createButtonComponent();
    this.buttonComponents.push(component);
    callback(component);
    return this;
  }

  addDropdown(callback: (dropdown: MockDropdownComponent) => void): this {
    const component = createDropdownComponent();
    this.dropdownComponents.push(component);
    callback(component);
    return this;
  }
}

jest.mock('node:fs');
jest.mock('obsidian', () => ({
  Notice: class MockNotice {
    constructor(message: string) {
      mockNotices.push(message);
    }
  },
  Setting: MockSetting,
}));
jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
jest.mock('@/providers/pi/app/PiWorkspaceServices', () => ({
  maybeGetPiWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: mockCliResolverReset,
    },
  })),
}));
jest.mock('@/providers/pi/runtime/PiModelDiscoveryService', () => ({
  PiModelDiscoveryService: jest.fn().mockImplementation(() => ({
    discoverModels: mockDiscoverModels,
  })),
}));
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

import { getPiProviderSettings } from '@/providers/pi/settings';
import { piSettingsTabRenderer } from '@/providers/pi/ui/PiSettingsTab';

const createdSettings: MockSetting[] = [];
const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.onChangeCallback = null;
  component.value = false;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: boolean) => Promise<void> | void): MockToggleComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.inputEl = {
    toggleClass: jest.fn(),
  };
  component.onChangeCallback = null;
  component.value = '';
  component.setPlaceholder = jest.fn(() => component);
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: string) => Promise<void> | void): MockTextComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createButtonComponent(): MockButtonComponent {
  const component = {} as MockButtonComponent;
  component.disabled = false;
  component.onClickCallback = null;
  component.text = '';
  component.setButtonText = jest.fn((value: string) => {
    component.text = value;
    return component;
  });
  component.setDisabled = jest.fn((value: boolean) => {
    component.disabled = value;
    return component;
  });
  component.onClick = (callback: () => Promise<void> | void): MockButtonComponent => {
    component.onClickCallback = callback;
    return component;
  };
  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.onChangeCallback = null;
  component.options = {};
  component.value = '';
  component.addOption = (value: string, label: string): MockDropdownComponent => {
    component.options[value] = label;
    return component;
  };
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: string) => Promise<void> | void): MockDropdownComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createElement(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    empty: jest.fn(),
    setText: jest.fn(),
    toggleClass: jest.fn(),
  };
}

function createContext(settings: Record<string, unknown>) {
  return {
    plugin: {
      saveSettings: jest.fn().mockResolvedValue(undefined),
      settings,
    },
    refreshModelSelectors: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
  };
}

function render(settings: Record<string, unknown>) {
  const context = createContext(settings);
  piSettingsTabRenderer.render(createElement(), context as any);
  return context;
}

function findSetting(name: string): MockSetting {
  const setting = [...createdSettings].reverse().find(entry => entry.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('PiSettingsTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdSettings.length = 0;
    mockNotices.length = 0;
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    mockDiscoverModels.mockResolvedValue({
      models: [{
        encodedId: 'pi:anthropic/claude-sonnet-4',
        id: 'claude-sonnet-4',
        input: ['text'],
        label: 'Claude Sonnet 4',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      }],
    });
  });

  it('updates provider config when Pi is enabled', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: { enabled: false } } };
    const context = render(settings);

    await findSetting('Enable Pi').toggleComponents[0].onChangeCallback?.(true);

    expect(getPiProviderSettings(settings).enabled).toBe(true);
    expect(context.plugin.saveSettings).toHaveBeenCalled();
    expect(context.refreshModelSelectors).toHaveBeenCalled();
  });

  it('does not render hidden command settings for Pi', () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    const context = render(settings);

    expect(context.renderHiddenProviderCommandSetting).not.toHaveBeenCalled();
  });

  it('does not render the chat input tool mode setting for Pi', () => {
    render({ providerConfigs: { pi: { toolMode: 'readonly' } } });

    expect(() => findSetting('Tool mode')).toThrow('Setting not found: Tool mode');
  });

  it('validates host-scoped CLI paths and resets the resolver after valid changes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockReturnValue(false);
    await cliInput.onChangeCallback?.('/missing/pi');
    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
    expect(mockCliResolverReset).not.toHaveBeenCalled();

    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    await cliInput.onChangeCallback?.('/valid/pi');
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/valid/pi',
    });
    expect(mockCliResolverReset).toHaveBeenCalled();
    expect(context.plugin.saveSettings).toHaveBeenCalled();
  });

  it('discovers models through PiModelDiscoveryService and reports failures', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    const context = render(settings);

    await findSetting('Discover models').buttonComponents[0].onClickCallback?.();

    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
    expect(getPiProviderSettings(settings).discoveredModels).toHaveLength(1);
    expect(getPiProviderSettings(settings).visibleModels).toEqual([]);
    expect(context.refreshModelSelectors).toHaveBeenCalled();

    mockDiscoverModels.mockResolvedValueOnce({ diagnostics: 'not logged in', models: [] });
    await findSetting('Discover models').buttonComponents[0].onClickCallback?.();
    expect(mockNotices[0]).toContain('not logged in');
  });

  it('persists visible model choices and aliases', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          discoveredModels: [{
            encodedId: 'pi:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'medium'],
          }],
          visibleModels: [],
        },
      },
    };
    const context = render(settings);
    const modelSetting = findSetting('Claude Sonnet 4');

    await modelSetting.toggleComponents[0].onChangeCallback?.(true);
    expect(getPiProviderSettings(settings).visibleModels).toEqual(['pi:anthropic/claude-sonnet-4']);

    await findSetting('Claude Sonnet 4').textComponents[0].onChangeCallback?.('Sonnet');
    expect(getPiProviderSettings(settings).modelAliases).toEqual({
      'pi:anthropic/claude-sonnet-4': 'Sonnet',
    });
    expect(context.refreshModelSelectors).toHaveBeenCalled();
  });
});
