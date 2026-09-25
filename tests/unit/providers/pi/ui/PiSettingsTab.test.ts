import * as fs from 'node:fs';

import { createMockEl } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockCLIResolverReset = jest.fn();
const mockDiscoverModels = jest.fn();
const mockNotices: string[] = [];

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

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.Mock;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
}

interface MockTextComponent {
  inputEl: {
    [key: string]: unknown;
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
  settingEl = { addClass: jest.fn() };
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
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
function createSettingsRenderer() {
  return createPiSettingsTabRenderer({
    modelCatalog: { markStale: jest.fn() },
    cliResolver: {
      reset: mockCLIResolverReset,
    },
  } as unknown as Parameters<typeof createPiSettingsTabRenderer>[0]);
}
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
import { createPiSettingsTabRenderer } from '@/providers/pi/ui/PiSettingsTab';

const createdSettings: MockSetting[] = [];
const createdDOMElements: any[] = [];
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
    ...createMockEl('input'),
    addEventListener: jest.fn(),
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
    ...createMockEl('div'),
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
      createdDOMElements.push(child);
      return child;
    }),
    createDiv: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      applyElementAttrs(child, attrs);
      createdDOMElements.push(child);
      return child;
    }),
    createSpan: jest.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'span';
      applyElementAttrs(child, attrs);
      createdDOMElements.push(child);
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
  const saveSettings = jest.fn().mockResolvedValue(undefined);
  const runProviderExecutionTransition = jest.fn(async (
    _providerIds: string[],
    mutation: () => Promise<void>,
  ) => mutation());
  const mutateSettings = jest.fn(async (
    mutation: (current: any) => void | Promise<void>,
  ) => {
    await mutation(settings);
    await saveSettings();
  });
  const applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[],
    mutation: (current: any) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => runProviderExecutionTransition(providerIds, async () => {
    await mutateSettings(mutation);
    await onApplied?.();
  }));
  return {
    plugin: {
      applyProviderRuntimeSettings,
      notifyProviderChatOptionsChanged: jest.fn(),
      runProviderExecutionTransition,
      saveSettings,
      settings,
      mutateSettings,
    },
    renderAgentSkillSettings: jest.fn(),
    notifyProviderModelOptionsChanged: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
  };
}

function render(settings: Record<string, unknown>) {
  const context = createContext(settings);
  createSettingsRenderer().render(createElement(), context as any);
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
    createdDOMElements.length = 0;
    mockNotices.length = 0;
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    mockDiscoverModels.mockResolvedValue({
      kind: 'completed',
      models: [],
    });
  });

  it.each([false, true])('clears legacy CLI configuration when restoring automatic detection (host override: %s)', async (hasHostOverride) => {
    const config = {
      cliPath: '/legacy/pi',
      cliPathsByHost: { 'other-host': '/keep/pi', ...(hasHostOverride ? { 'current-host': '/host/pi' } : {}) },
    };
    const settings: Record<string, unknown> = { providerConfigs: { pi: config } };
    render(settings);
    const input = findSetting('CLI path').textComponents[0];
    expect(input.value).toBe(hasHostOverride ? '/host/pi' : '/legacy/pi');
    await applyTextInput(input, '');
    expect(getPiProviderSettings(settings).cliPath).toBe('');
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ 'other-host': '/keep/pi' });
  });

  it('updates provider config when Pi is enabled', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: { enabled: false } } };
    const context = render(settings);

    const enableSetting = findSetting('Enable Pi');
    await enableSetting.toggleComponents[0].onChangeCallback?.(true);

    expect(getPiProviderSettings(settings).enabled).toBe(true);
    expect(context.plugin.saveSettings).toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('pi');
  });

  it('commits Pi enablement inside the execution transition without metadata startup', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: true } },
    };
    const context = render(settings);
    const enableSetting = findSetting('Enable Pi');
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      expect(providerIds).toEqual(['pi']);
      expect(getPiProviderSettings(settings).enabled).toBe(true);
      await mutation();
      expect(getPiProviderSettings(settings).enabled).toBe(false);
    });

    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.plugin.runProviderExecutionTransition).toHaveBeenCalledTimes(1);
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes the Pi toggle when disabling the final provider is rejected', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: true } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    const coordinator = jest.requireMock('@/core/providers/ProviderSettingsCoordinator')
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);
    toggle.setValue.mockClear();

    await toggle.onChangeCallback?.(false);

    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('restores the Pi enablement toggle when the execution transition fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition failed',
    );

    expect(getPiProviderSettings(settings).enabled).toBe(false);
    expect(toggle.setValue).toHaveBeenLastCalledWith(false);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes Pi enablement to durable settings after a late transition failure', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      _providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      await mutation();
      throw new Error('transition completion failed');
    });

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition completion failed',
    );

    expect(getPiProviderSettings(settings).enabled).toBe(true);
    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('renders shared skills and keeps hidden provider commands separate', () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    const context = render(settings);

    expect(context.renderAgentSkillSettings).toHaveBeenCalledWith(
      expect.anything(),
      'pi',
    );
    expect(context.renderHiddenProviderCommandSetting).toHaveBeenCalledWith(
      expect.anything(),
      'pi',
      expect.objectContaining({ name: 'Hidden Pi commands and skills' }),
    );
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
    await applyTextInput(cliInput, '/missing/pi');
    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
    expect(mockCLIResolverReset).not.toHaveBeenCalled();

    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '/valid/pi');
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/valid/pi',
    });
    expect(mockCLIResolverReset).toHaveBeenCalled();
    expect(context.plugin.saveSettings).toHaveBeenCalled();
  });

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockImplementation((filePath: unknown) => String(filePath) === '/my tools/pi');
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '"/my tools/pi"');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '"/my tools/pi"',
    });
  });

  it('commits the Pi CLI path and retains discovery inside the execution transition', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          cliPathsByHost: { 'current-host': '/old/pi' },
          discoveredModels: [{ encodedId: 'pi:test/cached', id: 'cached', provider: 'test', label: 'Cached', input: ['text'], reasoning: false, thinkingLevels: ['off'] }],
        },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    const order: string[] = [];
    mockCLIResolverReset.mockImplementationOnce(() => {
      order.push('resolver-reset');
    });
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      order.push('transition-start');
      expect(providerIds).toEqual(['pi']);
      expect(getPiProviderSettings(settings).cliPathsByHost['current-host'])
        .toBe('/old/pi');
      await mutation();
      order.push('settings-committed');
      expect(getPiProviderSettings(settings).discoveredModels).toHaveLength(1);
      expect(mockCLIResolverReset).toHaveBeenCalledTimes(1);
      order.push('transition-end');
    });

    await applyTextInput(cliInput, '/new/pi');

    expect(order).toEqual([
      'transition-start',
      'resolver-reset',
      'settings-committed',
      'transition-end',
    ]);
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/pi',
    });
    expect(context.plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['pi'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('retains the Pi CLI draft when transition setup fails before mutation', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: { cliPathsByHost: { 'current-host': '/old/pi' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/failed/pi';
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await applyTextInput(cliInput, '/failed/pi');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/old/pi',
    });
    expect(cliInput.inputEl.value).toBe('/failed/pi');
    expect(mockCLIResolverReset).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('resynchronizes the Pi CLI input to durable settings when resolver reset fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: { cliPathsByHost: { 'current-host': '/old/pi' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/new/pi';
    mockCLIResolverReset.mockImplementationOnce(() => {
      throw new Error('resolver reset failed');
    });

    await applyTextInput(cliInput, '/new/pi');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/pi',
    });
    expect(cliInput.inputEl.value).toBe('/new/pi');
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });
});

jest.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: jest.fn(() => ({ refresh: jest.fn() })) }));
