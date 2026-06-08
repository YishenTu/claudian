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
    addClass: jest.Mock;
    style: Record<string, string>;
    toggleClass: jest.Mock;
    value: string;
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
const createdDomElements: any[] = [];
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
    addClass: jest.fn(),
    style: {},
    toggleClass: jest.fn(),
    value: '',
  };
  component.onChangeCallback = null;
  component.value = '';
  component.setPlaceholder = jest.fn(() => component);
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
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
  const classes = new Set<string>();
  const eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const element: any = {
    checked: false,
    open: false,
    placeholder: '',
    style: {},
    title: '',
    value: '',
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
    createEl: jest.fn((tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = tag;
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
    createDiv: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
    createSpan: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'span';
      applyElementAttrs(child, attrs);
      createdDomElements.push(child);
      return child;
    }),
  };

  return element;
}

function applyElementAttrs(element: any, attrs?: Record<string, unknown>): void {
  if (!attrs) {
    return;
  }
  if (typeof attrs.cls === 'string') {
    element.cls = attrs.cls;
  }
  if (typeof attrs.text === 'string') {
    element.text = attrs.text;
  }
  if (typeof attrs.value === 'string') {
    element.value = attrs.value;
  }
  if (typeof attrs.type === 'string') {
    element.type = attrs.type;
  }
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

function findElement(tag: string, cls: string): any {
  const element = [...createdDomElements].reverse().find(
    candidate => candidate.tag === tag && candidate.cls === cls,
  );
  if (!element) {
    throw new Error(`Element not found: ${tag}.${cls}`);
  }
  return element;
}

function findInputByType(type: string): any {
  const element = [...createdDomElements].reverse().find(
    candidate => candidate.tag === 'input' && candidate.type === type,
  );
  if (!element) {
    throw new Error(`Input not found: ${type}`);
  }
  return element;
}

describe('PiSettingsTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdSettings.length = 0;
    createdDomElements.length = 0;
    mockNotices.length = 0;
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    mockDiscoverModels.mockResolvedValue({
      models: [],
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
    mockDiscoverModels.mockResolvedValueOnce({
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
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          visibleModels: ['pi:anthropic/claude-sonnet-4'],
        },
      },
    };
    const context = render(settings);

    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');

    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
    expect(getPiProviderSettings(settings).discoveredModels).toHaveLength(1);
    expect(getPiProviderSettings(settings).visibleModels).toEqual(['pi:anthropic/claude-sonnet-4']);
    expect(context.refreshModelSelectors).toHaveBeenCalled();

    mockDiscoverModels.mockResolvedValueOnce({ diagnostics: 'not logged in', models: [] });
    await findElement('button', 'claudian-provider-model-picker-action').dispatchMockEvent('click');
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
    const checkboxEl = findInputByType('checkbox');

    checkboxEl.checked = true;
    await checkboxEl.dispatchMockEvent('change');
    expect(getPiProviderSettings(settings).visibleModels).toEqual(['pi:anthropic/claude-sonnet-4']);

    const aliasInput = findElement('input', 'claudian-provider-model-picker-selected-alias');
    aliasInput.value = 'Sonnet';
    await aliasInput.dispatchMockEvent('blur');

    expect(getPiProviderSettings(settings).modelAliases).toEqual({
      'pi:anthropic/claude-sonnet-4': 'Sonnet',
    });
    expect(context.refreshModelSelectors).toHaveBeenCalled();
  });
});
